/**
 * Deterministic video sampler and stepper for Tier 1 clip evaluation.
 *
 * Supports:
 * 1. requestVideoFrameCallback (rVFC) sampling as primary path:
 *    - Plays clip muted at playbackRate 1.0.
 *    - Samples frames when mediaTime advances by sample interval (default 0.4s, adjustable)
 *      AND the detector is idle.
 *    - Uses mediaTime as the timestamp for tracking, closing speed, and rules.
 * 2. Seek-based stepper fallback when requestVideoFrameCallback is unsupported:
 *    - Seeks in steps of sample interval with 2.0s stall timeout.
 * 3. Video diagnostics:
 *    - readyState, networkState, error code, duration, videoWidth/Height,
 *      and the last 10 media events (loadeddata, seeking, seeked, canplay, stalled, error, etc.).
 * 4. HEVC detection & ffmpeg conversion instructions.
 * 5. Deduplicated CSV export for decisions and alerts with True/False/Missed marking.
 */

import { Direction, Tier1HazardType, TrackDecisionLog } from "./types";

export const DEFAULT_SAMPLE_INTERVAL_SEC = 0.4;
export const DEFAULT_STEP_SEC = 0.4;
export const SEEK_TIMEOUT_MS = 2000;

export interface IVideoElement {
  currentTime: number;
  duration: number;
  paused: boolean;
  ended: boolean;
  readyState?: number;
  networkState?: number;
  videoWidth?: number;
  videoHeight?: number;
  playbackRate?: number;
  muted?: boolean;
  playsInline?: boolean;
  error?: { code?: number; message?: string } | null;
  requestVideoFrameCallback?: (
    callback: (now: number, metadata: { mediaTime: number; presentedFrames?: number }) => void
  ) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
  play?: () => Promise<void> | void;
  pause?: () => void;
  addEventListener(event: string, listener: EventListener | (() => void)): void;
  removeEventListener(event: string, listener: EventListener | (() => void)): void;
}

export interface VideoMediaEvent {
  time: string;
  event: string;
  timestampMs: number;
}

export interface VideoDiagnostics {
  readyState: number;
  readyStateText: string;
  networkState: number;
  networkStateText: string;
  errorCode: number | null;
  errorMessage: string | null;
  duration: number;
  videoWidth: number;
  videoHeight: number;
  lastEvents: VideoMediaEvent[];
}

export function formatReadyState(state: number): string {
  switch (state) {
    case 0:
      return "0: HAVE_NOTHING";
    case 1:
      return "1: HAVE_METADATA";
    case 2:
      return "2: HAVE_CURRENT_DATA";
    case 3:
      return "3: HAVE_FUTURE_DATA";
    case 4:
      return "4: HAVE_ENOUGH_DATA";
    default:
      return `${state}: UNKNOWN`;
  }
}

export function formatNetworkState(state: number): string {
  switch (state) {
    case 0:
      return "0: NETWORK_EMPTY";
    case 1:
      return "1: NETWORK_IDLE";
    case 2:
      return "2: NETWORK_LOADING";
    case 3:
      return "3: NETWORK_NO_SOURCE";
    default:
      return `${state}: UNKNOWN`;
  }
}

/** Extract full diagnostic snapshot from video element. */
export function extractDiagnostics(
  video: IVideoElement,
  lastEvents: VideoMediaEvent[] = [],
  newEvent?: string
): VideoDiagnostics {
  const events = [...lastEvents];
  if (newEvent) {
    events.push({
      time: `${(video.currentTime || 0).toFixed(2)}s`,
      event: newEvent,
      timestampMs: Date.now(),
    });
    if (events.length > 10) {
      events.splice(0, events.length - 10);
    }
  }

  const err = video.error;
  return {
    readyState: video.readyState ?? 0,
    readyStateText: formatReadyState(video.readyState ?? 0),
    networkState: video.networkState ?? 0,
    networkStateText: formatNetworkState(video.networkState ?? 0),
    errorCode: err?.code ?? null,
    errorMessage: err?.message ?? null,
    duration: video.duration || 0,
    videoWidth: video.videoWidth || 0,
    videoHeight: video.videoHeight || 0,
    lastEvents: events,
  };
}

export interface SamplerCallbacks {
  onStep: (sampleTime: number) => Promise<void>;
  onProgress?: (currentTime: number, duration: number) => void;
  onStall?: (stallMessage: string) => void;
  onError?: (errorMessage: string) => void;
  onComplete?: () => void;
  onPause?: () => void;
  isDetectorIdle?: () => boolean;
}

/** Check if video/file is HEVC / H.265 and cannot be natively decoded. */
export function isHevcClip(
  source: { name?: string; type?: string; canPlayType?: (t: string) => CanPlayTypeResult }
): boolean {
  if (source.name && /(hevc|h265)/i.test(source.name)) {
    return true;
  }
  if (source.type && /(hevc|h265|hvc1)/i.test(source.type)) {
    return true;
  }
  if (source.canPlayType) {
    const hevcPlayable = source.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"');
    if (hevcPlayable === "") {
      return true;
    }
  }
  return false;
}

/** Generate ffmpeg conversion command to re-encode HEVC / incompatible videos to H.264. */
export function getFfmpegConversionCommand(filename: string): string {
  const safeName = filename || "input.mp4";
  const base = safeName.replace(/\.[^/.]+$/, "");
  return `ffmpeg -i "${safeName}" -c:v libx264 -pix_fmt yuv420p -c:a aac "${base}_h264.mp4"`;
}

/**
 * Wait for video to complete seeking to target time, with 2s stall timeout.
 */
export async function waitForSeek(
  video: IVideoElement,
  targetTime: number,
  timeoutMs: number = SEEK_TIMEOUT_MS
): Promise<{ ok: boolean; stalled: boolean; actualTime: number }> {
  return new Promise((resolve) => {
    let resolved = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    };

    const onSeeked = () => {
      if (resolved) return;
      resolved = true;
      cleanup();
      const diff = Math.abs(video.currentTime - targetTime);
      if (diff > 0.1 && video.currentTime < video.duration - 0.05) {
        resolve({ ok: false, stalled: true, actualTime: video.currentTime });
      } else {
        resolve({ ok: true, stalled: false, actualTime: video.currentTime });
      }
    };

    const onError = () => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve({ ok: false, stalled: false, actualTime: video.currentTime });
    };

    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError);

    timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve({ ok: false, stalled: true, actualTime: video.currentTime });
    }, timeoutMs);
  });
}

/**
 * Video clip sampler supporting requestVideoFrameCallback with seek fallback.
 */
export class VideoClipSampler {
  protected isRunning = false;
  protected isPaused = false;
  protected isCancelled = false;
  protected sampleIntervalSec: number;
  protected rvfcHandle: number | null = null;
  protected watchdogTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    protected video: IVideoElement,
    protected callbacks: SamplerCallbacks,
    sampleIntervalSec: number = DEFAULT_SAMPLE_INTERVAL_SEC
  ) {
    this.sampleIntervalSec = sampleIntervalSec;
  }

  public getRunning(): boolean {
    return this.isRunning;
  }

  public getPaused(): boolean {
    return this.isPaused;
  }

  public getMode(): "rvfc" | "seek" {
    return typeof this.video.requestVideoFrameCallback === "function" &&
      typeof this.video.cancelVideoFrameCallback === "function"
      ? "rvfc"
      : "seek";
  }

  public setSampleInterval(intervalSec: number): void {
    this.sampleIntervalSec = Math.max(0.05, intervalSec);
  }

  public async start(startFromCurrent = false): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.isPaused = false;
    this.isCancelled = false;

    if (this.getMode() === "rvfc") {
      await this.startRvfc(startFromCurrent);
    } else {
      await this.startSeek(startFromCurrent);
    }
  }

  /**
   * Primary sampling path via requestVideoFrameCallback.
   */
  private async startRvfc(startFromCurrent: boolean): Promise<void> {
    const video = this.video;
    video.muted = true;
    if (video.playbackRate !== undefined) {
      video.playbackRate = 1.0;
    }

    if (!startFromCurrent) {
      video.currentTime = 0;
    }

    let lastSampledMediaTime = -Infinity;
    let lastSeenMediaTime = video.currentTime;
    let elapsedWithoutAdvanceMs = 0;

    // 2s Stall Watchdog checking every 250ms
    this.watchdogTimer = setInterval(() => {
      if (!this.isRunning || this.isPaused || this.isCancelled) return;
      if (video.ended) return;

      elapsedWithoutAdvanceMs += 250;
      if (elapsedWithoutAdvanceMs >= 2000) {
        this.stop();
        const msg = `video stalled at t=${lastSeenMediaTime.toFixed(2)}s`;
        this.callbacks.onStall?.(msg);
      }
    }, 250);

    // Watch for stalled event from media pipeline
    const onStalledEvent = () => {
      if (!this.isRunning || this.isPaused || this.isCancelled) return;
      setTimeout(() => {
        if (this.isRunning && elapsedWithoutAdvanceMs >= 1800) {
          this.stop();
          this.callbacks.onStall?.(`video stalled at t=${video.currentTime.toFixed(2)}s`);
        }
      }, 500);
    };
    video.addEventListener("stalled", onStalledEvent);

    const onFrame = (_now: number, metadata: { mediaTime: number; presentedFrames?: number }) => {
      if (!this.isRunning || this.isPaused || this.isCancelled) return;

      // Immediately queue next rVFC so no frames are dropped
      this.rvfcHandle = video.requestVideoFrameCallback!(onFrame);

      const mediaTime = metadata?.mediaTime ?? video.currentTime;
      const duration = video.duration || 0;

      // Update watchdog on progress
      if (mediaTime > lastSeenMediaTime + 0.005) {
        lastSeenMediaTime = mediaTime;
        elapsedWithoutAdvanceMs = 0;
      }

      if (video.ended || (duration > 0 && mediaTime >= duration - 0.05)) {
        this.stop();
        video.removeEventListener("stalled", onStalledEvent);
        this.callbacks.onComplete?.();
        return;
      }

      if (video.error) {
        this.stop();
        video.removeEventListener("stalled", onStalledEvent);
        this.callbacks.onError?.(
          `Video error: ${video.error.message || `Code ${video.error.code}`}`
        );
        return;
      }

      // Check mediaTime advancement against sample interval AND detector idle
      const timeDelta = mediaTime - lastSampledMediaTime;
      const isIdle = this.callbacks.isDetectorIdle ? this.callbacks.isDetectorIdle() : true;

      if (timeDelta >= this.sampleIntervalSec - 0.01 && isIdle) {
        lastSampledMediaTime = mediaTime;
        Promise.resolve(this.callbacks.onStep(mediaTime))
          .then(() => {
            this.callbacks.onProgress?.(mediaTime, duration);
          })
          .catch((err) => {
            this.stop();
            video.removeEventListener("stalled", onStalledEvent);
            this.callbacks.onError?.(`Step error at t=${mediaTime.toFixed(2)}s: ${String(err)}`);
          });
      }
    };

    this.rvfcHandle = video.requestVideoFrameCallback!(onFrame);

    if (video.play) {
      try {
        await video.play();
      } catch (err) {
        this.stop();
        video.removeEventListener("stalled", onStalledEvent);
        this.callbacks.onError?.(`Failed to start video playback: ${String(err)}`);
      }
    }
  }

  /**
   * Fallback sampling path via seeking when rVFC is not available.
   */
  private async startSeek(startFromCurrent: boolean): Promise<void> {
    const video = this.video;
    video.paused = true;

    const duration = video.duration || 0;
    let sampleTime = startFromCurrent
      ? Math.round(video.currentTime / this.sampleIntervalSec) * this.sampleIntervalSec
      : 0.0;

    sampleTime = Math.round(sampleTime * 100) / 100;

    while (this.isRunning && !this.isCancelled && !this.isPaused) {
      if (video.ended || (duration > 0 && sampleTime > duration)) {
        this.isRunning = false;
        this.callbacks.onComplete?.();
        break;
      }

      if (video.error) {
        this.isRunning = false;
        this.callbacks.onError?.(
          `Video playback error: ${video.error.message || `Code ${video.error.code}`}`
        );
        break;
      }

      const prevTime = video.currentTime;
      video.currentTime = sampleTime;

      const seekResult = await waitForSeek(video, sampleTime, SEEK_TIMEOUT_MS);
      if (this.isCancelled || this.isPaused) break;

      if (!seekResult.ok && seekResult.stalled) {
        this.isRunning = false;
        this.callbacks.onStall?.(`video stalled at t=${video.currentTime.toFixed(2)}s`);
        break;
      }

      if (
        sampleTime > 0 &&
        Math.abs(video.currentTime - prevTime) < 0.001 &&
        sampleTime < duration - 0.05
      ) {
        this.isRunning = false;
        this.callbacks.onStall?.(`video stalled at t=${video.currentTime.toFixed(2)}s`);
        break;
      }

      try {
        await this.callbacks.onStep(sampleTime);
        this.callbacks.onProgress?.(sampleTime, duration);
      } catch (err) {
        this.isRunning = false;
        this.callbacks.onError?.(`Step error at t=${sampleTime}s: ${String(err)}`);
        break;
      }

      sampleTime = Math.round((sampleTime + this.sampleIntervalSec) * 100) / 100;
    }

    if (this.isPaused) {
      this.callbacks.onPause?.();
    }
  }

  public pause(): void {
    if (!this.isRunning) return;
    this.isPaused = true;
    this.isRunning = false;
    this.cleanupRvfc();
    this.video.pause?.();
    this.callbacks.onPause?.();
  }

  public resume(): void {
    if (this.isRunning) return;
    this.start(true);
  }

  public cancel(): void {
    this.isCancelled = true;
    this.isRunning = false;
    this.isPaused = false;
    this.cleanupRvfc();
    this.video.pause?.();
    this.video.currentTime = 0;
  }

  public stop(): void {
    this.isRunning = false;
    this.cleanupRvfc();
    this.video.pause?.();
  }

  private cleanupRvfc(): void {
    if (this.watchdogTimer !== null) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.rvfcHandle !== null && this.video.cancelVideoFrameCallback) {
      this.video.cancelVideoFrameCallback(this.rvfcHandle);
      this.rvfcHandle = null;
    }
  }
}

/**
 * Backward compatibility alias for DeterministicVideoStepper.
 */
export class DeterministicVideoStepper extends VideoClipSampler {}

/**
 * Format decision logs into clean CSV without duplicates, including unique id and sample time.
 */
export function formatDecisionsToCsv(
  decisions: TrackDecisionLog[],
  fallbackClipName = "clip"
): string {
  const headers = [
    "id",
    "clip",
    "sample_time",
    "t",
    "class",
    "direction",
    "decision",
    "reason",
    "label",
  ];

  const seenIds = new Set<string>();
  const rows: string[] = [];

  for (const d of decisions) {
    if (seenIds.has(d.id)) continue;
    seenIds.add(d.id);

    const sampleTime = (d.sample_time ?? d.t).toFixed(2);
    const tVal = d.t.toFixed(2);

    rows.push(
      [
        JSON.stringify(d.id),
        JSON.stringify(d.clip || fallbackClipName),
        sampleTime,
        tVal,
        JSON.stringify(d.class),
        JSON.stringify(d.direction),
        JSON.stringify(d.decision),
        JSON.stringify(d.reason),
        JSON.stringify(d.label || ""),
      ].join(",")
    );
  }

  return [headers.join(","), ...rows].join("\n");
}

/**
 * Format triggered alerts log into CSV with labels for True/False/Missed analysis.
 */
export function formatAlertsToCsv(
  alerts: Array<{
    id?: string;
    timeSec: number;
    alert: {
      type: string;
      direction: string;
      distance: string;
      urgency: number;
      reason?: string;
      confidence?: number;
    };
    phraseEn: string;
    phraseHi: string;
    label?: string;
  }>,
  clipName = "clip"
): string {
  const headers = [
    "id",
    "clip",
    "time_sec",
    "type",
    "direction",
    "distance",
    "urgency",
    "phrase_en",
    "phrase_hi",
    "label",
    "reason",
  ];

  const rows = alerts.map((a, i) =>
    [
      JSON.stringify(a.id || `alert_${a.timeSec.toFixed(2)}_${a.alert.type}_${i}`),
      JSON.stringify(clipName),
      a.timeSec.toFixed(2),
      JSON.stringify(a.alert.type),
      JSON.stringify(a.alert.direction),
      JSON.stringify(a.alert.distance),
      a.alert.urgency,
      JSON.stringify(a.phraseEn),
      JSON.stringify(a.phraseHi),
      JSON.stringify(a.label || ""),
      JSON.stringify(a.alert.reason || ""),
    ].join(",")
  );

  return [headers.join(","), ...rows].join("\n");
}

/**
 * Build a manual missed hazard log entry.
 */
export function createMissedHazardLog(
  clipName: string,
  sampleTime: number,
  hazardType: Tier1HazardType | string,
  direction: Direction
): TrackDecisionLog {
  const t = Math.round(sampleTime * 100) / 100;
  return {
    id: `missed_${t.toFixed(2)}_${hazardType}_${direction}_${Date.now()}`,
    clip: clipName,
    t,
    sample_time: t,
    class: hazardType,
    direction,
    decision: "missed_hazard",
    reason: `Manually marked missed ${hazardType} on ${direction}`,
    label: "missed",
    trackId: -1,
  };
}
