/** Tier1 detector manager — runs on main thread, manages worker and tracking. */

import { DEFAULT_TIER1_CONFIG } from "./config";
import { analyzeFrameLuminance, updateTracker } from "./math";
import {
  BenchmarkResult,
  FrameLuminanceStats,
  RawDetection,
  Tier1Alert,
  Tier1Config,
  Tier1Metrics,
  TrackDecisionLog,
  TrackedObject,
} from "./types";

export class Tier1Detector {
  private worker: Worker | null = null;
  private config: Tier1Config;
  private tracks: TrackedObject[] = [];
  private metrics: Tier1Metrics = {
    fps: 0,
    latencyMs: 0,
    backend: "initializing",
    loadTimeMs: 0,
    status: "idle",
  };
  private inFlight = false;
  private frameCount = 0;
  private lastFpsCalcTime = performance.now();
  private lastSpokenHazardAt = 0;
  private consecutiveBlockedFrames = 0;
  private consecutiveClearFrames = 0;
  private isCameraBlocked = false;
  private sampleCanvas: HTMLCanvasElement | null = null;
  private lastFrameWidth = 640;
  private lastFrameHeight = 360;
  private benchmarkResolver: ((res: BenchmarkResult) => void) | null = null;
  private pendingFrameResolver:
    | ((res: {
        updatedTracks: TrackedObject[];
        alerts: Tier1Alert[];
        decisions: TrackDecisionLog[];
      }) => void)
    | null = null;

  private onAlertCallbacks: Array<(alert: Tier1Alert) => void> = [];
  private onMetricsCallbacks: Array<(metrics: Tier1Metrics) => void> = [];
  private onErrorCallbacks: Array<(errorMsg: string) => void> = [];
  private onCameraBlockedCallbacks: Array<() => void> = [];
  private onCameraClearCallbacks: Array<() => void> = [];
  private onDecisionCallbacks: Array<(d: TrackDecisionLog) => void> = [];

  constructor(config: Partial<Tier1Config> = {}) {
    this.config = { ...DEFAULT_TIER1_CONFIG, ...config };
  }

  public updateConfig(newConfig: Partial<Tier1Config>): void {
    this.config = { ...this.config, ...newConfig };
  }

  public clear(): void {
    this.tracks = [];
    this.inFlight = false;
  }

  public isBusy(): boolean {
    return this.inFlight;
  }

  public onDecision(cb: (d: TrackDecisionLog) => void): () => void {
    this.onDecisionCallbacks.push(cb);
    return () => {
      this.onDecisionCallbacks = this.onDecisionCallbacks.filter((c) => c !== cb);
    };
  }

  public onAlert(cb: (alert: Tier1Alert) => void): () => void {
    this.onAlertCallbacks.push(cb);
    return () => {
      this.onAlertCallbacks = this.onAlertCallbacks.filter((c) => c !== cb);
    };
  }

  public onMetrics(cb: (metrics: Tier1Metrics) => void): () => void {
    this.onMetricsCallbacks.push(cb);
    return () => {
      this.onMetricsCallbacks = this.onMetricsCallbacks.filter((c) => c !== cb);
    };
  }

  public onError(cb: (errorMsg: string) => void): () => void {
    this.onErrorCallbacks.push(cb);
    return () => {
      this.onErrorCallbacks = this.onErrorCallbacks.filter((c) => c !== cb);
    };
  }

  public onCameraBlocked(cb: () => void): () => void {
    this.onCameraBlockedCallbacks.push(cb);
    return () => {
      this.onCameraBlockedCallbacks = this.onCameraBlockedCallbacks.filter((c) => c !== cb);
    };
  }

  public onCameraClear(cb: () => void): () => void {
    this.onCameraClearCallbacks.push(cb);
    return () => {
      this.onCameraClearCallbacks = this.onCameraClearCallbacks.filter((c) => c !== cb);
    };
  }

  public getMetrics(): Tier1Metrics {
    return { ...this.metrics };
  }

  public getTracks(): TrackedObject[] {
    return [...this.tracks];
  }

  public start(): void {
    if (this.worker) return;

    this.metrics.status = "loading";
    this.notifyMetrics();

    try {
      this.worker = new Worker(new URL("./worker.ts", import.meta.url), {
        type: "module",
      });

      this.worker.onmessage = (e: MessageEvent) => {
        this.handleWorkerMessage(e.data);
      };

      this.worker.onerror = (err) => {
        const msg = `Worker error: ${err.message || String(err)}`;
        this.metrics.status = "error";
        this.metrics.errorMessage = msg;
        this.notifyMetrics();
        this.notifyError(msg);
      };

      // Initialize local offline model
      this.worker.postMessage({
        type: "init",
        modelUrl: "/models/coco-ssd/model.json",
        minScore: this.config.minScore,
        maxDetections: this.config.maxDetections,
      });
    } catch (err) {
      const msg = `Failed to spawn worker: ${String(err)}`;
      this.metrics.status = "error";
      this.metrics.errorMessage = msg;
      this.notifyMetrics();
      this.notifyError(msg);
    }
  }

  public stop(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.inFlight = false;
    this.tracks = [];
    this.metrics.status = "idle";
    this.notifyMetrics();
  }

  public async switchBackend(backend: "webgl" | "wasm" | "cpu"): Promise<string> {
    return new Promise((resolve) => {
      if (!this.worker) {
        resolve("failed");
        return;
      }
      const handler = (e: MessageEvent) => {
        if (e.data.type === "backend_switched") {
          this.worker?.removeEventListener("message", handler);
          this.metrics.backend = e.data.backend;
          this.notifyMetrics();
          resolve(e.data.backend);
        }
      };
      this.worker.addEventListener("message", handler);
      this.worker.postMessage({
        type: "switch_backend",
        backend,
      });
    });
  }

  public runBenchmark(
    backend: "webgl" | "wasm" | "cpu",
    inputSize: 192 | 256 | 320 = 320,
    numFrames = 100
  ): Promise<BenchmarkResult> {
    return new Promise((resolve) => {
      if (!this.worker) {
        resolve({
          backend,
          inputSize,
          numFrames: 0,
          medianMs: 0,
          p95Ms: 0,
          fps: 0,
          totalElapsedMs: 0,
          error: "Worker not running",
        });
        return;
      }
      this.benchmarkResolver = resolve;
      this.worker.postMessage({
        type: "benchmark",
        backend,
        inputSize,
        numFrames,
      });
    });
  }

  public async detectFrame(
    source: HTMLVideoElement | HTMLCanvasElement,
    timestampSec = performance.now() / 1000
  ): Promise<{
    updatedTracks: TrackedObject[];
    alerts: Tier1Alert[];
    decisions: TrackDecisionLog[];
  }> {
    const width = source instanceof HTMLVideoElement ? source.videoWidth : source.width;
    const height = source instanceof HTMLVideoElement ? source.videoHeight : source.height;

    if (width <= 0 || height <= 0) {
      return { updatedTracks: this.tracks, alerts: [], decisions: [] };
    }
    this.lastFrameWidth = width;
    this.lastFrameHeight = height;

    // 1. Requirement B6: Lens blocked / dark frame check via 16x16 luminance sampling
    this.checkLensBlocked(source);

    if (this.isCameraBlocked) {
      return { updatedTracks: [], alerts: [], decisions: [] };
    }

    if (!this.worker || this.metrics.status !== "ready") {
      return { updatedTracks: this.tracks, alerts: [], decisions: [] };
    }

    if (this.inFlight) {
      return { updatedTracks: this.tracks, alerts: [], decisions: [] };
    }

    this.inFlight = true;

    return new Promise((resolve) => {
      this.pendingFrameResolver = resolve;

      (async () => {
        try {
          // Downscale to inputSize (default 320, 256 for slower phones)
          // Frame capture with resizeWidth <= 320 so full-resolution frame is never copied
          const inputSize = this.config.inputSize ?? 320;
          const targetWidth = Math.min(inputSize, Math.min(320, width));
          const targetHeight = Math.round((height / width) * targetWidth);
          const bitmap = await createImageBitmap(source, {
            resizeWidth: targetWidth,
            resizeHeight: targetHeight,
            resizeQuality: "low",
          });

          this.worker?.postMessage(
            {
              type: "detect",
              bitmap,
              timestamp: timestampSec,
              width,
              height,
              minScore: this.config.minScore,
              maxDetections: this.config.maxDetections,
            },
            [bitmap]
          );
        } catch (err) {
          this.inFlight = false;
          this.pendingFrameResolver = null;
          console.warn("[Tier1Detector] Frame capture error:", err);
          resolve({ updatedTracks: this.tracks, alerts: [], decisions: [] });
        }
      })();
    });
  }

  public async processFrame(
    source: HTMLVideoElement | HTMLCanvasElement,
    timestampSec = performance.now() / 1000
  ): Promise<void> {
    await this.detectFrame(source, timestampSec);
  }

  private checkLensBlocked(source: HTMLVideoElement | HTMLCanvasElement): void {
    try {
      if (!this.sampleCanvas && typeof document !== "undefined") {
        this.sampleCanvas = document.createElement("canvas");
        this.sampleCanvas.width = 16;
        this.sampleCanvas.height = 16;
      }
      if (!this.sampleCanvas) return;

      const ctx = this.sampleCanvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;

      ctx.drawImage(source, 0, 0, 16, 16);
      const imgData = ctx.getImageData(0, 0, 16, 16).data;
      const stats = analyzeFrameLuminance(imgData);

      this.handleLuminance(stats);
    } catch {
      // Ignore canvas read errors
    }
  }

  public handleLuminance(stats: FrameLuminanceStats): void {
    if (stats.isBlocked) {
      this.consecutiveBlockedFrames += 1;
      this.consecutiveClearFrames = 0;

      if (this.consecutiveBlockedFrames >= 3 && !this.isCameraBlocked) {
        this.isCameraBlocked = true;
        this.tracks = [];
        for (const cb of this.onCameraBlockedCallbacks) {
          cb();
        }
      }
    } else {
      this.consecutiveBlockedFrames = 0;
      if (this.isCameraBlocked) {
        this.consecutiveClearFrames += 1;
        if (this.consecutiveClearFrames >= 2) {
          this.isCameraBlocked = false;
          this.consecutiveClearFrames = 0;
          for (const cb of this.onCameraClearCallbacks) {
            cb();
          }
        }
      }
    }
  }

  private handleWorkerMessage(data: {
    type: "ready" | "error" | "detections" | "benchmark_result" | "backend_switched";
    backend?: string;
    loadTimeMs?: number;
    error?: string;
    detections?: RawDetection[];
    timestamp?: number;
    latencyMs?: number;
  }): void {
    if (data.type === "benchmark_result") {
      if (this.benchmarkResolver) {
        this.benchmarkResolver(data as unknown as BenchmarkResult);
        this.benchmarkResolver = null;
      }
      return;
    }

    if (data.type === "ready") {
      this.metrics.status = "ready";
      this.metrics.backend = data.backend ?? "unknown";
      this.metrics.loadTimeMs = data.loadTimeMs ?? 0;
      this.notifyMetrics();
      return;
    }

    if (data.type === "error") {
      this.inFlight = false;
      if (this.pendingFrameResolver) {
        const resolver = this.pendingFrameResolver;
        this.pendingFrameResolver = null;
        resolver({ updatedTracks: this.tracks, alerts: [], decisions: [] });
      }
      if (this.metrics.status === "loading") {
        this.metrics.status = "error";
        this.metrics.errorMessage = data.error;
        this.notifyMetrics();
        this.notifyError(data.error ?? "Unknown error");
      }
      return;
    }

    if (data.type === "detections") {
      this.inFlight = false;
      const { detections, timestamp, latencyMs, backend, loadTimeMs } = data as {
        detections: RawDetection[];
        timestamp: number;
        latencyMs: number;
        backend: string;
        loadTimeMs: number;
      };

      // Measure FPS
      this.frameCount += 1;
      const now = performance.now();
      const elapsed = (now - this.lastFpsCalcTime) / 1000;
      if (elapsed >= 1.0) {
        this.metrics.fps = Math.round((this.frameCount / elapsed) * 10) / 10;
        this.frameCount = 0;
        this.lastFpsCalcTime = now;
      }

      this.metrics.latencyMs = latencyMs;
      this.metrics.backend = backend;
      this.metrics.loadTimeMs = loadTimeMs;
      this.notifyMetrics();

      if (this.isCameraBlocked) {
        if (this.pendingFrameResolver) {
          const resolver = this.pendingFrameResolver;
          this.pendingFrameResolver = null;
          resolver({ updatedTracks: [], alerts: [], decisions: [] });
        }
        return;
      }

      // Update tracker
      const { updatedTracks, alerts, decisions } = updateTracker(
        this.tracks,
        detections,
        timestamp,
        this.lastFrameWidth,
        this.lastFrameHeight,
        this.config
      );

      this.tracks = updatedTracks;

      const nowMs = performance.now();
      for (const alert of alerts) {
        if (alert.urgency < 3 && nowMs - this.lastSpokenHazardAt < this.config.globalRateLimitMs) {
          const d = decisions.find(
            (item) => item.trackId === alert.trackedId && item.decision === "alerted"
          );
          if (d) {
            d.decision = "suppressed: rate_limited";
            d.reason = `suppressed by 3s global rate limit (${((nowMs - this.lastSpokenHazardAt) / 1000).toFixed(1)}s < 3s)`;
            const matchedTrack = this.tracks.find((t) => t.id === alert.trackedId);
            if (matchedTrack) matchedTrack.lastDecision = "suppressed: rate_limited";
          }
          continue;
        }
        this.lastSpokenHazardAt = nowMs;
        for (const cb of this.onAlertCallbacks) {
          cb(alert);
        }
      }

      for (const d of decisions) {
        for (const cb of this.onDecisionCallbacks) {
          cb(d);
        }
      }

      if (this.pendingFrameResolver) {
        const resolver = this.pendingFrameResolver;
        this.pendingFrameResolver = null;
        resolver({ updatedTracks: this.tracks, alerts, decisions });
      }
    }
  }

  private notifyMetrics(): void {
    const copy = this.getMetrics();
    for (const cb of this.onMetricsCallbacks) {
      cb(copy);
    }
  }

  private notifyError(msg: string): void {
    for (const cb of this.onErrorCallbacks) {
      cb(msg);
    }
  }
}
