/**
 * Deterministic video sampler and stepper for Tier 1 clip evaluation.
 *
 * Supports:
 * 1. requestVideoFrameCallback (rVFC) sampling with automatic stall recovery:
 *    - On waiting, stalled, or unexpected pause: pauses sampler, waits for canplay, calls play() again, continues.
 *    - Counts recoveries ("recovered N times").
 *    - Aborts only after 3 failed recoveries or 8 s without progress.
 *    - Captures frames with createImageBitmap(video, {resizeWidth: 320}) so full-resolution frame is never copied.
 *    - Detects clips > 854 px wide and provides ffmpeg downscale command.
 * 2. Seek-based stepper fallback when requestVideoFrameCallback is unsupported.
 * 3. Video diagnostics telemetry (readyState, networkState, error code, duration, videoWidth/Height, last 10 events).
 * 4. Ground truth labeling:
 *    - "True alert" / "False alert" on alerted rows.
 *    - "Correct silence" / "Should have alerted" on suppressed rows.
 *    - Bulk "Mark all unlabeled as correct".
 *    - "+ Mark Missed" hazard logging.
 *    - Summary metrics: true alerts, false alerts, correct silences, missed hazards, alerts/min, precision, recall.
 *    - CSV export with all labels.
 */

import { Direction, Tier1HazardType, TrackDecisionLog } from "./types";

export const DEFAULT_SAMPLE_INTERVAL_SEC = 0.4;
export const DEFAULT_STEP_SEC = 0.4;
export const SEEK_TIMEOUT_MS = 2000;
export const MAX_RECOVERY_ATTEMPTS = 3;
export const MAX_NO_PROGRESS_MS = 8000;

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
  recoveryCount: number;
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

/** Check if clip resolution is larger than 854 px wide (e.g. 1080p or 720p). */
export function isHighResolutionClip(video: { videoWidth?: number }): boolean {
  return (video.videoWidth ?? 0) > 854;
}

/** Generate ffmpeg command to downscale high-resolution videos to standard 480p (854 px wide). */
export function getFfmpegDownscaleCommand(filename: string): string {
  const safeName = filename || "input.mp4";
  const base = safeName.replace(/\.[^/.]+$/, "");
  return `ffmpeg -i "${safeName}" -vf "scale=854:-2" -c:v libx264 -pix_fmt yuv420p -c:a copy "${base}_480p.mp4"`;
}

/** Extract full diagnostic snapshot from video element. */
export function extractDiagnostics(
  video: IVideoElement,
  lastEvents: VideoMediaEvent[] = [],
  newEvent?: string,
  recoveryCount = 0
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
    recoveryCount,
  };
}

export interface SampleSpacingStats {
  min: number;
  median: number;
  max: number;
  count: number;
  warning: boolean;
}

/** Compute min, median, max spacing across sampled frames and warn if median > 0.6s (Req 1). */
export function computeSampleSpacingStats(spacings: number[]): SampleSpacingStats {
  if (spacings.length === 0) {
    return { min: 0, median: 0, max: 0, count: 0, warning: false };
  }
  const sorted = [...spacings].sort((a, b) => a - b);
  const min = Math.round(sorted[0]! * 100) / 100;
  const max = Math.round(sorted[sorted.length - 1]! * 100) / 100;
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 !== 0
      ? Math.round(sorted[mid]! * 100) / 100
      : Math.round(((sorted[mid - 1]! + sorted[mid]!) / 2) * 100) / 100;
  return {
    min,
    median,
    max,
    count: spacings.length,
    warning: median > 0.6,
  };
}

export interface SamplerCallbacks {
  onStep: (sampleTime: number, actualTime?: number) => Promise<void>;
  onProgress?: (currentTime: number, duration: number) => void;
  onStall?: (stallMessage: string) => void;
  onError?: (errorMessage: string) => void;
  onComplete?: () => void;
  onPause?: () => void;
  onRecovery?: (recoveryCount: number, isRecovering: boolean) => void;
  onSampleSpacingStats?: (stats: SampleSpacingStats) => void;
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
 * Video clip sampler supporting requestVideoFrameCallback with automatic stall recovery
 * and seek fallback.
 */
export class VideoClipSampler {
  protected isRunning = false;
  protected isPaused = false;
  protected isCancelled = false;
  protected userPaused = false;
  protected isRecovering = false;
  protected sampleIntervalSec: number;
  protected rvfcHandle: number | null = null;
  protected watchdogTimer: ReturnType<typeof setInterval> | null = null;

  // Recovery tracking
  protected recoveryCount = 0;
  protected consecutiveFailedRecoveries = 0;
  protected lastProgressTimestamp = Date.now();
  protected lastSeenMediaTime = 0;

  private boundOnWaiting: (() => void) | null = null;
  private boundOnStalled: (() => void) | null = null;
  private boundOnPause: (() => void) | null = null;

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

  public getRecoveryCount(): number {
    return this.recoveryCount;
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

  public async start(startFromCurrent = false, offlineEval = false): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.isPaused = false;
    this.isCancelled = false;
    this.userPaused = false;
    this.isRecovering = false;
    this.consecutiveFailedRecoveries = 0;
    this.lastProgressTimestamp = Date.now();
    this.lastSeenMediaTime = this.video.currentTime;

    if (offlineEval) {
      await this.startOfflineEval(startFromCurrent);
    } else if (this.getMode() === "rvfc") {
      await this.startRvfc(startFromCurrent);
    } else {
      await this.startSeek(startFromCurrent);
    }
  }

  /**
   * Offline deterministic evaluation (Requirement 1):
   * Independent of device speed.
   * Plays forward to next sample time on exact 0.4s grid, pauses, runs detector to completion,
   * records result, then resumes.
   * Measures actual sample spacing (min, median, max) and warns if median > 0.6s.
   */
  private async startOfflineEval(startFromCurrent: boolean): Promise<void> {
    const video = this.video;
    video.muted = true;
    if (video.playbackRate !== undefined) {
      video.playbackRate = 1.0;
    }

    const duration = video.duration || 0;
    let targetTime = startFromCurrent
      ? Math.round(video.currentTime / this.sampleIntervalSec) * this.sampleIntervalSec
      : 0.0;
    targetTime = Math.round(targetTime * 100) / 100;

    let prevActualTime: number | null = null;
    const actualSpacings: number[] = [];

    // Ensure video is initially paused
    try {
      video.pause?.();
    } catch {
      // ignore
    }
    if (!startFromCurrent) {
      video.currentTime = 0;
    }

    while (this.isRunning && !this.isCancelled && !this.isPaused) {
      if (video.ended || (duration > 0 && targetTime > duration)) {
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

      // Step 1: Advance video to targetTime by playing forward, then pause (Req 1)
      const actualTime = await this.playToNextSample(targetTime);
      if (this.isCancelled || this.isPaused) break;

      // Track sample spacing
      if (prevActualTime !== null) {
        const delta = Math.round(Math.abs(actualTime - prevActualTime) * 100) / 100;
        if (delta > 0) {
          actualSpacings.push(delta);
          const stats = computeSampleSpacingStats(actualSpacings);
          this.callbacks.onSampleSpacingStats?.(stats);
        }
      }
      prevActualTime = actualTime;

      // Step 2: Run detector to completion on the paused frame (Req 1)
      try {
        await this.callbacks.onStep(targetTime, actualTime);
        this.callbacks.onProgress?.(actualTime, duration);
      } catch (err) {
        this.isRunning = false;
        this.callbacks.onError?.(`Step error at t=${targetTime.toFixed(2)}s: ${String(err)}`);
        break;
      }

      // Step 3: Advance exact 0.4s grid
      targetTime = Math.round((targetTime + this.sampleIntervalSec) * 100) / 100;
    }

    if (this.isPaused) {
      this.callbacks.onPause?.();
    }
  }

  /**
   * Play forward to target sample time and pause immediately (Requirement 1).
   * Keeps hardware decoders running naturally while halting during inference.
   */
  private playToNextSample(targetTime: number): Promise<number> {
    const video = this.video;

    // If already at or beyond targetTime
    if (video.currentTime >= targetTime - 0.02) {
      try {
        video.pause?.();
      } catch {
        // ignore
      }
      return Promise.resolve(video.currentTime);
    }

    if (typeof video.requestVideoFrameCallback === "function") {
      return new Promise((resolve) => {
        let resolved = false;
        let handle: number | null = null;
        let safetyTimer: ReturnType<typeof setTimeout> | null = null;

        const cleanup = () => {
          if (safetyTimer) clearTimeout(safetyTimer);
          if (handle !== null && video.cancelVideoFrameCallback) {
            video.cancelVideoFrameCallback(handle);
            handle = null;
          }
          try {
            video.pause?.();
          } catch {
            // ignore
          }
        };

        const finish = (time: number) => {
          if (resolved) return;
          resolved = true;
          cleanup();
          resolve(time);
        };

        const onFrame = (_now: number, metadata: { mediaTime: number }) => {
          if (resolved) return;
          const curTime = metadata?.mediaTime ?? video.currentTime;
          const dur = video.duration || 0;
          if (
            curTime >= targetTime - 0.02 ||
            video.ended ||
            (dur > 0 && curTime >= dur - 0.05)
          ) {
            finish(curTime);
            return;
          }
          handle = video.requestVideoFrameCallback!(onFrame);
        };

        handle = video.requestVideoFrameCallback!(onFrame);

        safetyTimer = setTimeout(() => {
          finish(video.currentTime);
        }, 2000);

        if (video.play) {
          try {
            const p = video.play();
            if (p && typeof p.catch === "function") {
              p.catch(() => finish(video.currentTime));
            }
          } catch {
            finish(video.currentTime);
          }
        }
      });
    } else {
      // Seek fallback
      video.currentTime = targetTime;
      return waitForSeek(video, targetTime).then((res) => res.actualTime);
    }
  }

  /**
   * Primary sampling path via requestVideoFrameCallback with automatic stall recovery.
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
    this.lastSeenMediaTime = video.currentTime;
    this.lastProgressTimestamp = Date.now();

    // Attach stall recovery listeners for waiting, stalled, and unexpected pause (Req 1)
    this.boundOnWaiting = () => {
      this.handleStallTrigger("waiting");
    };
    this.boundOnStalled = () => {
      this.handleStallTrigger("stalled");
    };
    this.boundOnPause = () => {
      // If paused unexpectedly by browser/codec while sampler is running
      if (this.isRunning && !this.userPaused && !this.isCancelled) {
        this.handleStallTrigger("unexpected_pause");
      }
    };

    video.addEventListener("waiting", this.boundOnWaiting);
    video.addEventListener("stalled", this.boundOnStalled);
    video.addEventListener("pause", this.boundOnPause);

    // Watchdog checking stall recovery and 8s no-progress abort limit (Req 1)
    this.watchdogTimer = setInterval(() => {
      if (!this.isRunning || this.userPaused || this.isCancelled) return;
      if (video.ended) return;

      const elapsedNoProgress = Date.now() - this.lastProgressTimestamp;

      // Abort after 8 s with no progress
      if (elapsedNoProgress >= MAX_NO_PROGRESS_MS) {
        this.stop();
        const msg = `video stalled at t=${this.lastSeenMediaTime.toFixed(2)}s (aborted: no progress for 8s)`;
        this.callbacks.onStall?.(msg);
        return;
      }

      // If no progress for 2.0 s and not currently recovering, attempt recovery
      if (!this.isRecovering && elapsedNoProgress >= 2000) {
        this.handleStallTrigger("watchdog_timeout");
      }
    }, 250);

    const onFrame = (_now: number, metadata: { mediaTime: number; presentedFrames?: number }) => {
      if (!this.isRunning || this.isPaused || this.isCancelled || this.isRecovering) return;

      // Immediately queue next rVFC so no frames are dropped
      this.rvfcHandle = video.requestVideoFrameCallback!(onFrame);

      const mediaTime = metadata?.mediaTime ?? video.currentTime;
      const duration = video.duration || 0;

      // Progress detected: reset watchdog timestamp and failed recovery counter
      if (mediaTime > this.lastSeenMediaTime + 0.005) {
        this.lastSeenMediaTime = mediaTime;
        this.lastProgressTimestamp = Date.now();
        this.consecutiveFailedRecoveries = 0;
      }

      if (video.ended || (duration > 0 && mediaTime >= duration - 0.05)) {
        this.stop();
        this.callbacks.onComplete?.();
        return;
      }

      if (video.error) {
        this.stop();
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
            this.callbacks.onError?.(`Step error at t=${mediaTime.toFixed(2)}s: ${String(err)}`);
          });
      }
    };

    this.rvfcHandle = video.requestVideoFrameCallback!(onFrame);

    if (video.play) {
      try {
        await video.play();
      } catch {
        this.handleStallTrigger("play_failed");
      }
    }
  }

  /**
   * Automatic stall recovery handler (Req 1):
   * On waiting, stalled or unexpected pause:
   * 1. Pauses sampler
   * 2. Waits for canplay
   * 3. Calls play() again and continues
   * 4. Increments recovery count ("recovered N times")
   * 5. Aborts after 3 failed recoveries or 8s no progress
   */
  public async handleStallTrigger(_trigger: string): Promise<void> {
    if (!this.isRunning || this.userPaused || this.isCancelled) return;
    if (this.isRecovering) return;

    // Check abort condition 1: 3 failed recoveries
    if (this.consecutiveFailedRecoveries >= MAX_RECOVERY_ATTEMPTS) {
      this.stop();
      const msg = `video stalled at t=${this.lastSeenMediaTime.toFixed(2)}s (aborted after ${MAX_RECOVERY_ATTEMPTS} failed recoveries)`;
      this.callbacks.onStall?.(msg);
      return;
    }

    // Check abort condition 2: 8 s with no progress
    if (Date.now() - this.lastProgressTimestamp >= MAX_NO_PROGRESS_MS) {
      this.stop();
      const msg = `video stalled at t=${this.lastSeenMediaTime.toFixed(2)}s (aborted: no progress for 8s)`;
      this.callbacks.onStall?.(msg);
      return;
    }

    this.isRecovering = true;
    this.callbacks.onRecovery?.(this.recoveryCount, true);

    // Pause the video/sampler during recovery
    try {
      this.video.pause?.();
    } catch {
      // ignore
    }

    // Wait for canplay event or readyState >= 2/3 with timeout
    const canPlayOk = await this.waitForCanPlay(2000);

    if (!this.isRunning || this.userPaused || this.isCancelled) {
      this.isRecovering = false;
      return;
    }

    if (canPlayOk) {
      try {
        if (this.video.play) {
          await this.video.play();
        }
        this.recoveryCount++;
        this.consecutiveFailedRecoveries = 0;
        this.isRecovering = false;
        this.lastProgressTimestamp = Date.now();
        this.callbacks.onRecovery?.(this.recoveryCount, false);

        // Resume rVFC loop if needed
        if (this.getMode() === "rvfc" && !this.rvfcHandle && this.video.requestVideoFrameCallback) {
          this.rvfcHandle = this.video.requestVideoFrameCallback(() => {
            this.startRvfc(true);
          });
        }
      } catch {
        this.consecutiveFailedRecoveries++;
        this.isRecovering = false;
        if (this.consecutiveFailedRecoveries >= MAX_RECOVERY_ATTEMPTS) {
          this.stop();
          const msg = `video stalled at t=${this.lastSeenMediaTime.toFixed(2)}s (aborted after ${MAX_RECOVERY_ATTEMPTS} failed recoveries)`;
          this.callbacks.onStall?.(msg);
        }
      }
    } else {
      this.consecutiveFailedRecoveries++;
      this.isRecovering = false;
      if (this.consecutiveFailedRecoveries >= MAX_RECOVERY_ATTEMPTS) {
        this.stop();
        const msg = `video stalled at t=${this.lastSeenMediaTime.toFixed(2)}s (aborted after ${MAX_RECOVERY_ATTEMPTS} failed recoveries)`;
        this.callbacks.onStall?.(msg);
      }
    }
  }

  private waitForCanPlay(timeoutMs = 3000): Promise<boolean> {
    const video = this.video;
    if (video.readyState !== undefined && video.readyState >= 3) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          video.removeEventListener("canplay", onCanPlay);
          resolve(video.readyState !== undefined && video.readyState >= 2);
        }
      }, timeoutMs);

      const onCanPlay = () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          video.removeEventListener("canplay", onCanPlay);
          resolve(true);
        }
      };

      video.addEventListener("canplay", onCanPlay);
    });
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
    this.userPaused = true;
    this.isPaused = true;
    this.isRunning = false;
    this.cleanupRvfc();
    this.video.pause?.();
    this.callbacks.onPause?.();
  }

  public resume(): void {
    if (this.isRunning) return;
    this.userPaused = false;
    this.start(true);
  }

  public cancel(): void {
    this.userPaused = true;
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
    if (this.boundOnWaiting) {
      this.video.removeEventListener("waiting", this.boundOnWaiting);
      this.boundOnWaiting = null;
    }
    if (this.boundOnStalled) {
      this.video.removeEventListener("stalled", this.boundOnStalled);
      this.boundOnStalled = null;
    }
    if (this.boundOnPause) {
      this.video.removeEventListener("pause", this.boundOnPause);
      this.boundOnPause = null;
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
 * Bulk label action: mark all unlabeled decisions as correct (Req 2).
 * - "alerted" rows -> "True alert"
 * - "suppressed" rows -> "Correct silence"
 * - "missed_hazard" rows -> "Should have alerted"
 */
export function markAllUnlabeledAsCorrect(decisions: TrackDecisionLog[]): TrackDecisionLog[] {
  return decisions.map((d) => {
    if (d.label && d.label.trim() !== "") {
      return d;
    }
    if (d.decision === "alerted") {
      return { ...d, label: "True alert" };
    }
    if (d.decision.startsWith("suppressed")) {
      return { ...d, label: "Correct silence" };
    }
    if (d.decision === "missed_hazard") {
      return { ...d, label: "Should have alerted" };
    }
    return d;
  });
}

/**
 * Metrics summary calculation (Req 2).
 */
export interface DecisionSummary {
  trueAlerts: number; // TP
  falseAlerts: number; // FP
  correctSilences: number; // TN
  missedHazards: number; // FN
  unlabeled: number;
  totalDecisions: number;
  totalAlerts: number;
  alertsPerMin: number;
  precision: number; // TP / (TP + FP)
  precisionPercent: string;
  recall: number; // TP / (TP + FN)
  recallPercent: string;
}

export function calculateDecisionSummary(
  decisions: TrackDecisionLog[],
  clipDurationSec: number
): DecisionSummary {
  let trueAlerts = 0;
  let falseAlerts = 0;
  let correctSilences = 0;
  let missedHazards = 0;
  let unlabeled = 0;
  let totalAlerts = 0;

  for (const d of decisions) {
    const lbl = d.label;
    if (d.decision === "alerted") {
      totalAlerts++;
      if (lbl === "True alert" || lbl === "True") {
        trueAlerts++;
      } else if (lbl === "False alert" || lbl === "False") {
        falseAlerts++;
      } else {
        unlabeled++;
      }
    } else if (d.decision === "missed_hazard") {
      missedHazards++;
      if (!lbl) {
        // Automatically considered "Should have alerted"
      }
    } else {
      // Suppressed decisions
      if (lbl === "Correct silence") {
        correctSilences++;
      } else if (lbl === "Should have alerted" || lbl === "Missed" || lbl === "missed") {
        missedHazards++;
      } else {
        unlabeled++;
      }
    }
  }

  const durationMin = clipDurationSec > 0 ? clipDurationSec / 60 : 0;
  const alertsPerMin = durationMin > 0 ? Math.round((totalAlerts / durationMin) * 10) / 10 : 0;

  const precisionDenom = trueAlerts + falseAlerts;
  const precision = precisionDenom > 0 ? trueAlerts / precisionDenom : 0;
  const precisionPercent = precisionDenom > 0 ? `${(precision * 100).toFixed(1)}%` : "N/A";

  const recallDenom = trueAlerts + missedHazards;
  const recall = recallDenom > 0 ? trueAlerts / recallDenom : 0;
  const recallPercent = recallDenom > 0 ? `${(recall * 100).toFixed(1)}%` : "N/A";

  return {
    trueAlerts,
    falseAlerts,
    correctSilences,
    missedHazards,
    unlabeled,
    totalDecisions: decisions.length,
    totalAlerts,
    alertsPerMin,
    precision: Math.round(precision * 1000) / 1000,
    precisionPercent,
    recall: Math.round(recall * 1000) / 1000,
    recallPercent,
  };
}

/**
 * Format decision logs into clean CSV without duplicates, including unique id, sample time, and labels.
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
 * Build a manual missed hazard log entry (Req 2).
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
    label: "Should have alerted",
    trackId: -1,
  };
}
