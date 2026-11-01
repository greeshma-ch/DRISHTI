/**
 * Deterministic video stepper for Tier 1 clip evaluation.
 *
 * Ensures:
 * 1. 0.25s deterministic steps (video.currentTime = nextTime, await seeked, detect, advance).
 * 2. Stalled video detection (timeout 2s or currentTime does not advance).
 * 3. One detection per sample time, using sample time as timestamp for tracking & closing speed.
 * 4. HEVC detection & ffmpeg conversion instructions.
 * 5. CSV export formatting with unique id, sample time, and no duplicates.
 */

import { Direction, Tier1HazardType, TrackDecisionLog } from "./types";

export const DEFAULT_STEP_SEC = 0.25;
export const SEEK_TIMEOUT_MS = 2000;

export interface IVideoElement {
  currentTime: number;
  duration: number;
  paused: boolean;
  ended: boolean;
  error?: { code?: number; message?: string } | null;
  addEventListener(event: string, listener: EventListener | (() => void)): void;
  removeEventListener(event: string, listener: EventListener | (() => void)): void;
}

export interface StepperCallbacks {
  onStep: (sampleTime: number) => Promise<void>;
  onProgress?: (currentTime: number, duration: number) => void;
  onStall?: (stallMessage: string) => void;
  onError?: (errorMessage: string) => void;
  onComplete?: () => void;
  onPause?: () => void;
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
      // Verify currentTime actually advanced or reached target
      const diff = Math.abs(video.currentTime - targetTime);
      if (diff > 0.1 && video.currentTime < video.duration - 0.05) {
        // Did not reach target time
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
 * Deterministic video stepper running 0.25s steps.
 */
export class DeterministicVideoStepper {
  private isRunning = false;
  private isPaused = false;
  private isCancelled = false;
  private stepSec: number;

  constructor(
    private video: IVideoElement,
    private callbacks: StepperCallbacks,
    stepSec: number = DEFAULT_STEP_SEC
  ) {
    this.stepSec = stepSec;
  }

  public getRunning(): boolean {
    return this.isRunning;
  }

  public getPaused(): boolean {
    return this.isPaused;
  }

  public async start(startFromCurrent = false): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.isPaused = false;
    this.isCancelled = false;

    // Ensure video is not free-playing
    this.video.paused = true;

    const duration = this.video.duration || 0;
    let sampleTime = startFromCurrent
      ? Math.round(this.video.currentTime / this.stepSec) * this.stepSec
      : 0.0;

    sampleTime = Math.round(sampleTime * 100) / 100;

    while (this.isRunning && !this.isCancelled && !this.isPaused) {
      if (this.video.ended || (duration > 0 && sampleTime > duration)) {
        this.isRunning = false;
        this.callbacks.onComplete?.();
        break;
      }

      if (this.video.error) {
        this.isRunning = false;
        this.callbacks.onError?.(
          `Video playback error: ${this.video.error.message || `Code ${this.video.error.code}`}`
        );
        break;
      }

      const prevTime = this.video.currentTime;
      this.video.currentTime = sampleTime;

      // Wait for seeked event or stall timeout
      const seekResult = await waitForSeek(this.video, sampleTime, SEEK_TIMEOUT_MS);

      if (this.isCancelled || this.isPaused) break;

      if (!seekResult.ok && seekResult.stalled) {
        // CurrentTime did not advance after seek within 2s
        this.isRunning = false;
        const msg = `video stalled at t=${this.video.currentTime.toFixed(2)}s`;
        this.callbacks.onStall?.(msg);
        break;
      }

      // Check if currentTime did not advance between successive non-initial steps
      if (sampleTime > 0 && Math.abs(this.video.currentTime - prevTime) < 0.001 && sampleTime < duration - 0.05) {
        this.isRunning = false;
        const msg = `video stalled at t=${this.video.currentTime.toFixed(2)}s`;
        this.callbacks.onStall?.(msg);
        break;
      }

      // Run detector once for this exact sample time
      try {
        await this.callbacks.onStep(sampleTime);
        this.callbacks.onProgress?.(sampleTime, duration);
      } catch (err) {
        this.isRunning = false;
        this.callbacks.onError?.(`Step error at t=${sampleTime}s: ${String(err)}`);
        break;
      }

      // Advance to next sample time
      sampleTime = Math.round((sampleTime + this.stepSec) * 100) / 100;
    }

    if (this.isPaused) {
      this.callbacks.onPause?.();
    }
  }

  public pause(): void {
    if (!this.isRunning) return;
    this.isPaused = true;
    this.isRunning = false;
  }

  public resume(): void {
    if (this.isRunning) return;
    this.start(true);
  }

  public cancel(): void {
    this.isCancelled = true;
    this.isRunning = false;
    this.isPaused = false;
  }

  public async stepOnce(forward = true): Promise<void> {
    const delta = forward ? this.stepSec : -this.stepSec;
    const target = Math.max(0, Math.round((this.video.currentTime + delta) / this.stepSec) * this.stepSec);
    this.video.currentTime = target;
    const res = await waitForSeek(this.video, target, SEEK_TIMEOUT_MS);
    if (res.ok) {
      await this.callbacks.onStep(target);
      this.callbacks.onProgress?.(target, this.video.duration || 0);
    }
  }
}

/**
 * Format decision logs into clean CSV without duplicates, including unique id and sample time.
 */
export function formatDecisionsToCsv(
  decisions: TrackDecisionLog[],
  fallbackClipName = "clip"
): string {
  const headers = ["id", "clip", "sample_time", "t", "class", "direction", "decision", "reason", "label"];

  const seenIds = new Set<string>();
  const rows: string[] = [];

  for (const d of decisions) {
    // Deduplicate exact log IDs if any
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

