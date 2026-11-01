import { describe, expect, it, vi } from "vitest";
import {
  createMissedHazardLog,
  DeterministicVideoStepper,
  formatDecisionsToCsv,
  getFfmpegConversionCommand,
  isHevcClip,
  IVideoElement,
  waitForSeek,
} from "./eval_stepper";
import { updateTracker } from "./math";
import { RawDetection, TrackDecisionLog, TrackedObject } from "./types";

class MockVideoElement implements IVideoElement {
  public currentTime = 0;
  public duration = 10.0;
  public paused = true;
  public ended = false;
  public error = null;

  private listeners = new Map<string, Set<() => void>>();
  public seekDelayMs = 0;
  public stallOnSeek = false;

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

  public simulateSeek(targetTime: number): void {
    if (this.stallOnSeek) {
      // Do not advance currentTime and do not trigger seeked
      return;
    }
    this.currentTime = targetTime;
    setTimeout(() => {
      this.trigger("seeked");
    }, this.seekDelayMs);
  }
}

describe("Deterministic Video Stepper & Clip Evaluation (Req 1-6)", () => {
  describe("1. Stalled video detection (Req 2 & 6)", () => {
    it("reports 'video stalled at t=...' when seek does not advance within 2s", async () => {
      vi.useFakeTimers();

      const mockVideo = new MockVideoElement();
      mockVideo.currentTime = 3.25;
      mockVideo.stallOnSeek = true; // Video decoder freezes

      let stallReported = "";
      const stepper = new DeterministicVideoStepper(
        mockVideo,
        {
          onStep: async () => {},
          onStall: (msg) => {
            stallReported = msg;
          },
        },
        0.25
      );

      // Start stepping
      const startPromise = stepper.start(true);

      // Fast-forward past the 2000 ms seek timeout
      await vi.advanceTimersByTimeAsync(2100);
      await startPromise;

      expect(stallReported).toBe("video stalled at t=3.25s");
      expect(stepper.getRunning()).toBe(false);

      vi.useRealTimers();
    });

    it("waitForSeek returns stalled=true on timeout", async () => {
      vi.useFakeTimers();

      const mockVideo = new MockVideoElement();
      mockVideo.currentTime = 2.0;

      const seekPromise = waitForSeek(mockVideo, 2.25, 2000);

      await vi.advanceTimersByTimeAsync(2050);
      const res = await seekPromise;

      expect(res.ok).toBe(false);
      expect(res.stalled).toBe(true);

      vi.useRealTimers();
    });
  });

  describe("2. One row per decision change (Req 3 & 6)", () => {
    const W = 640;
    const H = 360;

    it("logs only on decision change, not repeated identical frames", () => {
      // Object detected at center mid
      const dets: RawDetection[] = [{ bbox: [270, 60, 100, 140], class: "car", score: 0.9 }];

      // Frame 1 (t=0.0): Newly tracked -> initial decision "suppressed: not_tracked_long_enough"
      const res1 = updateTracker([], dets, 0.0, W, H, undefined, "test_clip.mp4");
      expect(res1.decisions.length).toBe(1);
      expect(res1.decisions[0]!.decision).toBe("suppressed: not_tracked_long_enough");

      // Frame 2 (t=0.25): Still tracked 0.25s < 0.8s -> decision unchanged!
      const res2 = updateTracker(res1.updatedTracks, dets, 0.25, W, H, undefined, "test_clip.mp4");
      expect(res2.decisions.length).toBe(0); // NO duplicate row!

      // Frame 3 (t=0.50): Still tracked 0.50s < 0.8s -> decision unchanged!
      const res3 = updateTracker(res2.updatedTracks, dets, 0.50, W, H, undefined, "test_clip.mp4");
      expect(res3.decisions.length).toBe(0); // NO duplicate row!

      // Frame 4 (t=0.80): Area grows substantially, tracked for 0.8s, closing sustained!
      const closingDets: RawDetection[] = [
        { bbox: [270, 40, 160, 170], class: "car", score: 0.95 },
      ];
      const res4 = updateTracker(res3.updatedTracks, closingDets, 0.80, W, H, undefined, "test_clip.mp4");
      // Decision changes to "alerted"!
      expect(res4.decisions.length).toBe(1);
      expect(res4.decisions[0]!.decision).toBe("alerted");

      // Frame 5 (t=1.05): Same object already announced
      const res5 = updateTracker(res4.updatedTracks, closingDets, 1.05, W, H, undefined, "test_clip.mp4");
      // Decision changes to "suppressed: already_announced"!
      expect(res5.decisions.length).toBe(1);
      expect(res5.decisions[0]!.decision).toBe("suppressed: already_announced");

      // Frame 6 (t=1.30): Still already announced -> unchanged!
      const res6 = updateTracker(res5.updatedTracks, closingDets, 1.30, W, H, undefined, "test_clip.mp4");
      expect(res6.decisions.length).toBe(0); // NO duplicate row!
    });
  });

  describe("3. Sample-time-based tracking (Req 1 & 6)", () => {
    const W = 640;
    const H = 360;

    it("an object tracked 1.0 s across 4 samples can alert", () => {
      // 4 samples: t = 0.0s, 0.25s, 0.50s, 0.75s, 1.0s (total elapsed = 1.0s >= 0.8s)
      const samples = [
        { t: 0.0, bbox: [270, 60, 100, 100] as [number, number, number, number] },
        { t: 0.25, bbox: [270, 55, 115, 120] as [number, number, number, number] },
        { t: 0.50, bbox: [270, 50, 130, 140] as [number, number, number, number] },
        { t: 0.75, bbox: [270, 45, 145, 160] as [number, number, number, number] },
        { t: 1.0, bbox: [270, 40, 160, 175] as [number, number, number, number] },
      ];

      let tracks: TrackedObject[] = [];
      let finalAlerts = 0;

      for (const sample of samples) {
        const dets: RawDetection[] = [{ bbox: sample.bbox, class: "car", score: 0.9 }];
        const step = updateTracker(tracks, dets, sample.t, W, H);
        tracks = step.updatedTracks;
        if (step.alerts.length > 0) {
          finalAlerts += step.alerts.length;
        }
      }

      // Tracked across 1.0s of sample time -> alert fired at or before 1.0s!
      expect(finalAlerts).toBeGreaterThanOrEqual(1);
      const carTrack = tracks.find((t) => t.class === "car");
      expect(carTrack).toBeDefined();
      expect(carTrack!.hasBeenAnnounced).toBe(true);
    });
  });

  describe("4. CSV export with unique id, sample time, and no duplicates (Req 3 & 4)", () => {
    it("formats decisions into CSV with unique IDs and no duplicate rows", () => {
      const logs: TrackDecisionLog[] = [
        {
          id: "d_0.25_1_person_not_tracked",
          clip: "clip_01.mp4",
          t: 0.25,
          sample_time: 0.25,
          class: "person",
          direction: "center",
          decision: "suppressed: not_tracked_long_enough",
          reason: "person tracked 0.25s < 0.8s",
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
        // Manually marked missed hazard
        createMissedHazardLog("clip_01.mp4", 1.25, "stairs", "center"),
      ];

      const csv = formatDecisionsToCsv(logs, "clip_01.mp4");
      const lines = csv.trim().split("\n");

      // Header + 3 unique rows (duplicate suppressed)
      expect(lines.length).toBe(4);
      expect(lines[0]).toBe("id,clip,sample_time,t,class,direction,decision,reason,label");

      // Verify row contents
      expect(lines[1]).toContain('"d_0.25_1_person_not_tracked"');
      expect(lines[1]).toContain('"clip_01.mp4",0.25,0.25');

      expect(lines[2]).toContain('"d_0.80_1_person_alerted"');
      expect(lines[2]).toContain('"True"');

      expect(lines[3]).toContain('"missed_hazard"');
      expect(lines[3]).toContain('"stairs"');
      expect(lines[3]).toContain('"missed"');
    });
  });

  describe("5. HEVC detection & ffmpeg command (Req 5)", () => {
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

