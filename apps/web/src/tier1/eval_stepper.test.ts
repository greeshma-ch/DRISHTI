import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SAMPLE_INTERVAL_SEC,
  VideoClipSampler,
  IVideoElement,
  createMissedHazardLog,
  extractDiagnostics,
  formatAlertsToCsv,
  formatDecisionsToCsv,
  formatNetworkState,
  formatReadyState,
  getFfmpegConversionCommand,
  isHevcClip,
  waitForSeek,
} from "./eval_stepper";
import { updateTracker } from "./math";
import { RawDetection, TrackDecisionLog } from "./types";

class MockVideoElement implements IVideoElement {
  public currentTime = 0;
  public duration = 10.0;
  public paused = true;
  public ended = false;
  public readyState = 0;
  public networkState = 0;
  public videoWidth = 0;
  public videoHeight = 0;
  public muted = false;
  public playbackRate = 1.0;
  public error: { code?: number; message?: string } | null = null;

  public requestVideoFrameCallback?: (
    callback: (now: number, metadata: { mediaTime: number; presentedFrames?: number }) => void
  ) => number;
  public cancelVideoFrameCallback?: (handle: number) => void;

  private listeners = new Map<string, Set<() => void>>();
  private rvfcCallbacks = new Map<
    number,
    (now: number, metadata: { mediaTime: number; presentedFrames?: number }) => void
  >();
  private nextRvfcHandle = 1;

  public seekDelayMs = 0;
  public stallOnSeek = false;

  constructor(enableRvfc = true) {
    if (enableRvfc) {
      this.requestVideoFrameCallback = (cb) => {
        const handle = this.nextRvfcHandle++;
        this.rvfcCallbacks.set(handle, cb);
        return handle;
      };
      this.cancelVideoFrameCallback = (handle) => {
        this.rvfcCallbacks.delete(handle);
      };
    } else {
      this.requestVideoFrameCallback = undefined;
      this.cancelVideoFrameCallback = undefined;
    }
  }

  public addEventListener(event: string, listener: () => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
  }

  public removeEventListener(event: string, listener: () => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  public trigger(event: string): void {
    const set = this.listeners.get(event);
    if (set) {
      for (const fn of Array.from(set)) {
        fn();
      }
    }
  }

  public async play(): Promise<void> {
    this.paused = false;
    this.trigger("play");
    this.trigger("playing");
  }

  public pause(): void {
    this.paused = true;
    this.trigger("pause");
  }

  public simulateSeek(targetTime: number): void {
    if (this.stallOnSeek) {
      return;
    }
    this.currentTime = targetTime;
    setTimeout(() => {
      this.trigger("seeked");
    }, this.seekDelayMs);
  }

  /**
   * Fire all currently queued rVFC callbacks with simulated media presentation time.
   */
  public stepRvfc(mediaTime: number): void {
    this.currentTime = mediaTime;
    const callbacks = Array.from(this.rvfcCallbacks.values());
    this.rvfcCallbacks.clear();
    for (const cb of callbacks) {
      cb(performance.now(), { mediaTime, presentedFrames: 1 });
    }
  }

  public hasPendingRvfc(): boolean {
    return this.rvfcCallbacks.size > 0;
  }
}

describe("Tier 1 Android Chrome Hardware Sampling & Eval Stepper (Req 1-5)", () => {
  describe("1. Diagnostics & Mocked Media Events (Req 1 & 2)", () => {
    it("tracks readyState, networkState, dimensions, error codes, and last 10 media events", () => {
      const mockVideo = new MockVideoElement();
      let diag = extractDiagnostics(mockVideo);

      expect(diag.readyState).toBe(0);
      expect(diag.readyStateText).toBe("0: HAVE_NOTHING");
      expect(diag.networkStateText).toBe("0: NETWORK_EMPTY");
      expect(diag.errorCode).toBeNull();
      expect(diag.lastEvents.length).toBe(0);

      // Simulate media events lifecycle
      mockVideo.readyState = 1;
      diag = extractDiagnostics(mockVideo, diag.lastEvents, "loadedmetadata");

      mockVideo.readyState = 2; // HAVE_CURRENT_DATA -> loadeddata
      mockVideo.videoWidth = 640;
      mockVideo.videoHeight = 360;
      diag = extractDiagnostics(mockVideo, diag.lastEvents, "loadeddata");

      mockVideo.readyState = 4; // HAVE_ENOUGH_DATA -> canplay
      mockVideo.networkState = 1; // NETWORK_IDLE
      diag = extractDiagnostics(mockVideo, diag.lastEvents, "canplay");

      diag = extractDiagnostics(mockVideo, diag.lastEvents, "play");
      diag = extractDiagnostics(mockVideo, diag.lastEvents, "playing");
      diag = extractDiagnostics(mockVideo, diag.lastEvents, "seeking");
      diag = extractDiagnostics(mockVideo, diag.lastEvents, "seeked");
      diag = extractDiagnostics(mockVideo, diag.lastEvents, "waiting");
      diag = extractDiagnostics(mockVideo, diag.lastEvents, "stalled");
      diag = extractDiagnostics(mockVideo, diag.lastEvents, "pause");

      // Now add 11th and 12th events -> capped at last 10
      mockVideo.error = { code: 3, message: "Decode error" };
      diag = extractDiagnostics(mockVideo, diag.lastEvents, "error");
      diag = extractDiagnostics(mockVideo, diag.lastEvents, "ended");

      expect(diag.lastEvents.length).toBe(10);
      expect(diag.lastEvents[diag.lastEvents.length - 1]!.event).toBe("ended");
      expect(diag.lastEvents[diag.lastEvents.length - 2]!.event).toBe("error");
      expect(diag.errorCode).toBe(3);
      expect(diag.errorMessage).toBe("Decode error");
      expect(diag.videoWidth).toBe(640);
      expect(diag.videoHeight).toBe(360);
      expect(diag.readyStateText).toBe("4: HAVE_ENOUGH_DATA");
    });

    it("verifies formatReadyState and formatNetworkState mappings", () => {
      expect(formatReadyState(0)).toBe("0: HAVE_NOTHING");
      expect(formatReadyState(2)).toBe("2: HAVE_CURRENT_DATA");
      expect(formatReadyState(4)).toBe("4: HAVE_ENOUGH_DATA");
      expect(formatNetworkState(1)).toBe("1: NETWORK_IDLE");
      expect(formatNetworkState(2)).toBe("2: NETWORK_LOADING");
    });
  });

  describe("2. requestVideoFrameCallback Sampling Path (Req 3)", () => {
    it("plays muted at playbackRate 1 and samples only when mediaTime advances by sample interval", async () => {
      const mockVideo = new MockVideoElement(true);
      mockVideo.duration = 5.0;

      const sampledMediaTimes: number[] = [];
      const sampler = new VideoClipSampler(
        mockVideo,
        {
          onStep: async (mediaTime) => {
            sampledMediaTimes.push(mediaTime);
          },
        },
        DEFAULT_SAMPLE_INTERVAL_SEC // 0.4s
      );

      expect(sampler.getMode()).toBe("rvfc");

      // Start sampler
      await sampler.start(false);

      expect(mockVideo.muted).toBe(true);
      expect(mockVideo.playbackRate).toBe(1.0);
      expect(mockVideo.paused).toBe(false);

      // Frame 1: at t = 0.00s -> sampled
      mockVideo.stepRvfc(0.00);
      expect(sampledMediaTimes).toEqual([0.00]);

      // Sub-interval frame: at t = 0.15s (delta = 0.15s < 0.4s) -> SKIPPED
      mockVideo.stepRvfc(0.15);
      expect(sampledMediaTimes).toEqual([0.00]);

      // Sub-interval frame: at t = 0.32s (delta = 0.32s < 0.4s) -> SKIPPED
      mockVideo.stepRvfc(0.32);
      expect(sampledMediaTimes).toEqual([0.00]);

      // Sample interval reached: at t = 0.41s (delta = 0.41s >= 0.4s) -> SAMPLED
      mockVideo.stepRvfc(0.41);
      expect(sampledMediaTimes).toEqual([0.00, 0.41]);

      // Next interval reached: at t = 0.82s -> SAMPLED
      mockVideo.stepRvfc(0.82);
      expect(sampledMediaTimes).toEqual([0.00, 0.41, 0.82]);

      sampler.cancel();
      expect(mockVideo.paused).toBe(true);
      expect(mockVideo.currentTime).toBe(0);
    });

    it("skips frames when detector is busy, then samples immediately when detector becomes idle", async () => {
      const mockVideo = new MockVideoElement(true);
      mockVideo.duration = 5.0;

      let detectorBusy = false;
      const sampledTimes: number[] = [];

      const sampler = new VideoClipSampler(
        mockVideo,
        {
          onStep: async (mediaTime) => {
            sampledTimes.push(mediaTime);
          },
          isDetectorIdle: () => !detectorBusy,
        },
        0.4
      );

      await sampler.start(false);

      // t = 0.0s: idle -> sampled
      mockVideo.stepRvfc(0.0);
      expect(sampledTimes).toEqual([0.0]);

      // Detector becomes busy processing frame
      detectorBusy = true;

      // t = 0.45s: delta >= 0.4s BUT detector is busy -> SKIPPED!
      mockVideo.stepRvfc(0.45);
      expect(sampledTimes).toEqual([0.0]);

      // t = 0.55s: still busy -> SKIPPED!
      mockVideo.stepRvfc(0.55);
      expect(sampledTimes).toEqual([0.0]);

      // Detector completes processing and becomes idle
      detectorBusy = false;

      // t = 0.60s: idle and delta >= 0.4s -> SAMPLED!
      mockVideo.stepRvfc(0.60);
      expect(sampledTimes).toEqual([0.0, 0.60]);

      sampler.cancel();
    });
  });

  describe("3. Seek Stepper Fallback Path (when rVFC is unsupported) (Req 3)", () => {
    it("falls back to seek stepper when requestVideoFrameCallback is missing", async () => {
      vi.useFakeTimers();

      // Video element with enableRvfc = false
      const mockVideo = new MockVideoElement(false);
      mockVideo.duration = 1.2;

      const sampledTimes: number[] = [];
      let completed = false;

      const sampler = new VideoClipSampler(
        mockVideo,
        {
          onStep: async (sampleTime) => {
            sampledTimes.push(sampleTime);
          },
          onComplete: () => {
            completed = true;
          },
        },
        0.4
      );

      expect(sampler.getMode()).toBe("seek");

      // Auto-simulate seeked event on currentTime changes
      let currTime = 0;
      Object.defineProperty(mockVideo, "currentTime", {
        get: () => currTime,
        set: (v: number) => {
          currTime = v;
          setTimeout(() => mockVideo.trigger("seeked"), 10);
        },
        configurable: true,
      });

      const startPromise = sampler.start(false);

      // Advance timers through 3 steps: 0.0s, 0.4s, 0.8s, 1.2s
      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(50);
      }
      await startPromise;

      expect(sampledTimes).toEqual([0.0, 0.4, 0.8, 1.2]);
      expect(completed).toBe(true);

      vi.useRealTimers();
    });
  });

  describe("4. Stall Reporting for Both Paths (Req 5)", () => {
    it("reports stall on rVFC path when mediaTime does not advance within 2s", async () => {
      vi.useFakeTimers();

      const mockVideo = new MockVideoElement(true);
      mockVideo.duration = 10.0;
      mockVideo.currentTime = 2.4;

      let stallMessage = "";
      const sampler = new VideoClipSampler(
        mockVideo,
        {
          onStep: async () => {},
          onStall: (msg) => {
            stallMessage = msg;
          },
        },
        0.4
      );

      await sampler.start(true);

      // Video starts, but decoder hangs and mediaTime never advances
      // Advance timers past 2000 ms stall threshold
      await vi.advanceTimersByTimeAsync(2200);

      expect(stallMessage).toBe("video stalled at t=2.40s");
      expect(sampler.getRunning()).toBe(false);

      vi.useRealTimers();
    });

    it("reports stall on seek path when seek does not complete within 2s", async () => {
      vi.useFakeTimers();

      const mockVideo = new MockVideoElement(false); // Seek mode
      mockVideo.duration = 10.0;
      mockVideo.currentTime = 2.0;
      mockVideo.stallOnSeek = true; // Decoder freezes

      let stallMessage = "";
      const sampler = new VideoClipSampler(
        mockVideo,
        {
          onStep: async () => {},
          onStall: (msg) => {
            stallMessage = msg;
          },
        },
        0.4
      );

      const startPromise = sampler.start(true);

      // Fast-forward past 2000 ms seek timeout
      await vi.advanceTimersByTimeAsync(2100);
      await startPromise;

      expect(stallMessage).toBe("video stalled at t=2.00s");
      expect(sampler.getRunning()).toBe(false);

      vi.useRealTimers();
    });

    it("waitForSeek returns stalled=true on timeout", async () => {
      vi.useFakeTimers();

      const mockVideo = new MockVideoElement(false);
      mockVideo.currentTime = 2.0;

      const seekPromise = waitForSeek(mockVideo, 2.4, 2000);

      await vi.advanceTimersByTimeAsync(2050);
      const res = await seekPromise;

      expect(res.ok).toBe(false);
      expect(res.stalled).toBe(true);

      vi.useRealTimers();
    });
  });

  describe("5. One Row Per Decision Change (Req 5)", () => {
    const W = 640;
    const H = 360;

    it("logs only on decision change, not repeated identical frames", () => {
      // Object detected at center mid
      const dets: RawDetection[] = [{ bbox: [270, 60, 100, 140], class: "car", score: 0.9 }];

      // Frame 1 (t=0.0): Newly tracked -> initial decision "suppressed: not_tracked_long_enough"
      const res1 = updateTracker([], dets, 0.0, W, H, undefined, "test_clip.mp4");
      expect(res1.decisions.length).toBe(1);
      expect(res1.decisions[0]!.decision).toBe("suppressed: not_tracked_long_enough");

      // Frame 2 (t=0.2): Still tracked 0.2s < 0.8s -> decision unchanged!
      const res2 = updateTracker(res1.updatedTracks, dets, 0.2, W, H, undefined, "test_clip.mp4");
      expect(res2.decisions.length).toBe(0); // NO duplicate row!

      // Frame 3 (t=0.4): Still tracked 0.4s < 0.8s -> decision unchanged!
      const res3 = updateTracker(res2.updatedTracks, dets, 0.4, W, H, undefined, "test_clip.mp4");
      expect(res3.decisions.length).toBe(0); // NO duplicate row!

      // Frame 4 (t=0.6): Still tracked 0.6s < 0.8s -> decision unchanged!
      const res4 = updateTracker(res3.updatedTracks, dets, 0.6, W, H, undefined, "test_clip.mp4");
      expect(res4.decisions.length).toBe(0); // NO duplicate row!

      // Frame 5 (t=0.8): Area grows, tracked for 0.8s, closing sustained!
      const closingDets: RawDetection[] = [
        { bbox: [270, 40, 160, 170], class: "car", score: 0.95 },
      ];
      const res5 = updateTracker(res4.updatedTracks, closingDets, 0.8, W, H, undefined, "test_clip.mp4");
      // Decision changes to "alerted"!
      expect(res5.decisions.length).toBe(1);
      expect(res5.decisions[0]!.decision).toBe("alerted");
    });
  });

  describe("6. CSV Export & Formatting (Req 4)", () => {
    it("formats decisions into CSV with unique IDs and no duplicate rows", () => {
      const logs: TrackDecisionLog[] = [
        {
          id: "d_0.40_1_person_not_tracked",
          clip: "clip_01.mp4",
          t: 0.4,
          sample_time: 0.4,
          class: "person",
          direction: "center",
          decision: "suppressed: not_tracked_long_enough",
          reason: "person tracked 0.40s < 0.8s",
          label: "",
          trackId: 1,
        },
        {
          id: "d_0.80_1_person_alerted",
          clip: "clip_01.mp4",
          t: 0.8,
          sample_time: 0.8,
          class: "person",
          direction: "center",
          decision: "alerted",
          reason: "person near center",
          label: "True",
          trackId: 1,
        },
        // Duplicate ID attempt
        {
          id: "d_0.80_1_person_alerted",
          clip: "clip_01.mp4",
          t: 0.8,
          sample_time: 0.8,
          class: "person",
          direction: "center",
          decision: "alerted",
          reason: "duplicate",
          label: "True",
          trackId: 1,
        },
        createMissedHazardLog("clip_01.mp4", 1.2, "stairs", "center"),
      ];

      const csv = formatDecisionsToCsv(logs, "clip_01.mp4");
      const lines = csv.trim().split("\n");

      expect(lines.length).toBe(4);
      expect(lines[0]).toBe("id,clip,sample_time,t,class,direction,decision,reason,label");
      expect(lines[1]).toContain('"d_0.40_1_person_not_tracked"');
      expect(lines[2]).toContain('"d_0.80_1_person_alerted"');
      expect(lines[2]).toContain('"True"');
      expect(lines[3]).toContain('"missed_hazard"');
    });

    it("formats alerts into CSV with ground truth annotations", () => {
      const alerts = [
        {
          id: "alert_0.80_vehicle_center_1",
          timeSec: 0.8,
          alert: {
            type: "vehicle",
            direction: "center",
            distance: "near",
            urgency: 3,
            reason: "closing rapidly",
          },
          phraseEn: "Vehicle ahead, stop",
          phraseHi: "वाहन आगे, रुकें",
          label: "True",
        },
        {
          id: "alert_1.60_person_right_2",
          timeSec: 1.6,
          alert: {
            type: "person",
            direction: "right",
            distance: "mid",
            urgency: 2,
            reason: "person entering path",
          },
          phraseEn: "Person on right, careful",
          phraseHi: "व्यक्ति दाएँ, सावधान",
          label: "False",
        },
      ];

      const csv = formatAlertsToCsv(alerts, "walk_clip.mp4");
      const lines = csv.trim().split("\n");

      expect(lines.length).toBe(3);
      expect(lines[0]).toBe(
        "id,clip,time_sec,type,direction,distance,urgency,phrase_en,phrase_hi,label,reason"
      );
      expect(lines[1]).toContain('"walk_clip.mp4",0.80,"vehicle","center","near",3');
      expect(lines[1]).toContain('"True"');
      expect(lines[2]).toContain('"False"');
    });

    it("detects HEVC in filename or mime and produces correct ffmpeg command", () => {
      expect(isHevcClip({ name: "my_video_hevc.mp4" })).toBe(true);
      expect(isHevcClip({ name: "walk_h265_raw.mp4" })).toBe(true);
      expect(isHevcClip({ name: "street_normal.mp4" })).toBe(false);

      const cmd = getFfmpegConversionCommand("phone_walk_hevc.mp4");
      expect(cmd).toContain('ffmpeg -i "phone_walk_hevc.mp4"');
      expect(cmd).toContain("-c:v libx264");
      expect(cmd).toContain("-pix_fmt yuv420p");
      expect(cmd).toContain("-c:a aac");
      expect(cmd).toContain('"phone_walk_hevc_h264.mp4"');
    });
  });
});
