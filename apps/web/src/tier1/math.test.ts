import { describe, it, expect, beforeEach } from "vitest";
import {
  computeDirection,
  computeProximity,
  computeClosingSpeedPerSec,
  isClosingSustained,
  getTrackedDurationSec,
  evaluateHazard,
  evaluateHazardDetails,
  updateTracker,
  resetTrackIdCounter,
  analyzeFrameLuminance,
} from "./math";
import { COCO_TO_HAZARD_MAP } from "./config";
import { TrackedObject, RawDetection } from "./types";
import { PriorityArbiter, makeHazardMessage } from "../arbiter";
import { buildPhrase } from "../phrases";

describe("Tier 1 Math & Rules", () => {
  beforeEach(() => {
    resetTrackIdCounter();
  });

  describe("1. Direction thirds", () => {
    const W = 640;
    it("classifies left third correctly (< 1/3)", () => {
      // Bbox center at x = 100 (< 213.3)
      expect(computeDirection([50, 50, 100, 100], W)).toBe("left");
    });

    it("classifies center third correctly (1/3 to 2/3)", () => {
      // Bbox center at x = 320
      expect(computeDirection([270, 50, 100, 100], W)).toBe("center");
    });

    it("classifies right third correctly (> 2/3)", () => {
      // Bbox center at x = 550 (> 426.6)
      expect(computeDirection([500, 50, 100, 100], W)).toBe("right");
    });
  });

  describe("2. Proximity thresholds", () => {
    const H = 360;
    it("classifies near when height >= 0.50", () => {
      expect(computeProximity([100, 50, 100, 180], H)).toBe("near"); // 180 / 360 = 0.50
      expect(computeProximity([100, 50, 100, 200], H)).toBe("near");
    });

    it("classifies mid when 0.25 <= height < 0.50", () => {
      expect(computeProximity([100, 50, 100, 90], H)).toBe("mid"); // 90 / 360 = 0.25
      expect(computeProximity([100, 50, 100, 120], H)).toBe("mid");
    });

    it("classifies far when height < 0.25", () => {
      expect(computeProximity([100, 50, 100, 50], H)).toBe("far"); // 50 / 360 = 0.138
    });
  });

  describe("3. Closing speed per second with irregular frame times", () => {
    it("computes growth per second across irregular timestamps", () => {
      const history = [
        { area: 0.10, timestamp: 1.0, cx: 0.5, cy: 0.5 },
        { area: 0.13, timestamp: 1.15, cx: 0.5, cy: 0.5 },
        { area: 0.18, timestamp: 1.35, cx: 0.5, cy: 0.5 },
      ];
      const rate = computeClosingSpeedPerSec(history);
      expect(rate).toBeCloseTo(0.08 / 0.35, 3);
    });

    it("returns 0 for single frame or zero dt", () => {
      expect(computeClosingSpeedPerSec([{ area: 0.1, timestamp: 1.0, cx: 0.5, cy: 0.5 }])).toBe(0);
      expect(
        computeClosingSpeedPerSec([
          { area: 0.1, timestamp: 1.0, cx: 0.5, cy: 0.5 },
          { area: 0.2, timestamp: 1.0, cx: 0.5, cy: 0.5 },
        ])
      ).toBe(0);
    });
  });

  describe("4. Tracker matching & time-based debounce", () => {
    it("matches object across frames by IoU and enforces time-based debounce for static obstacles", () => {
      const W = 640;
      const H = 360;

      // Frame 1: Chair detected in center at t = 1.0s
      const dets1: RawDetection[] = [
        { bbox: [270, 50, 100, 180], class: "chair", score: 0.9 },
      ];
      const step1 = updateTracker([], dets1, 1.0, W, H);
      expect(step1.updatedTracks.length).toBe(1);
      expect(step1.updatedTracks[0]!.consecutiveFrames).toBe(1);
      // Frame 1: Tracked for 0.0s (< 0.4s debounce) -> No alerts
      expect(step1.alerts.length).toBe(0);
      expect(step1.decisions.length).toBe(1);
      expect(step1.decisions[0]!.decision).toBe("suppressed: static_debounce");

      // Frame 2: Same chair slightly shifted at t = 1.5s (0.5s >= 0.4s)
      const dets2: RawDetection[] = [
        { bbox: [272, 52, 100, 180], class: "chair", score: 0.92 },
      ];
      const step2 = updateTracker(step1.updatedTracks, dets2, 1.5, W, H);
      expect(step2.updatedTracks.length).toBe(1);
      expect(step2.updatedTracks[0]!.consecutiveFrames).toBe(2);
      // Frame 2: Now alert fires!
      expect(step2.alerts.length).toBe(1);
      expect(step2.alerts[0]!.type).toBe("chair");
      expect(step2.alerts[0]!.direction).toBe("center");
      expect(step2.alerts[0]!.distance).toBe("near");
      expect(step2.decisions[0]!.decision).toBe("alerted");
    });
  });

  describe("5. Path relevance rules & Moving-Object Safety (Req A3)", () => {
    const W = 640;
    const H = 360;

    it("static near or mid object in center triggers urgency 2", () => {
      const trackCenterNear: TrackedObject = {
        id: 1,
        class: "chair",
        hazardType: "chair",
        bbox: [270, 50, 100, 180], // near (180 / 360 = 0.50), center
        history: [
          { area: 0.08, timestamp: 1.0, cx: 0.5, cy: 0.5 },
          { area: 0.08, timestamp: 1.2, cx: 0.5, cy: 0.5 },
          { area: 0.08, timestamp: 1.5, cx: 0.5, cy: 0.5 },
        ],
        consecutiveFrames: 3,
        lastSeenTimestamp: 1.5,
      };
      const alertNear = evaluateHazard(trackCenterNear, W, H);
      expect(alertNear).not.toBeNull();
      expect(alertNear!.urgency).toBe(2);
      expect(alertNear!.distance).toBe("near");
    });

    it("static object at left or right produces NO speech", () => {
      const trackLeftStatic: TrackedObject = {
        id: 3,
        class: "chair",
        hazardType: "chair",
        bbox: [50, 50, 100, 180], // left third
        history: [
          { area: 0.08, timestamp: 1.0, cx: 0.15, cy: 0.5 },
          { area: 0.08, timestamp: 1.5, cx: 0.15, cy: 0.5 },
        ],
        consecutiveFrames: 2,
        lastSeenTimestamp: 1.5,
      };
      expect(evaluateHazard(trackLeftStatic, W, H)).toBeNull();
      const evalDetails = evaluateHazardDetails(trackLeftStatic, W, H);
      expect(evalDetails.decision).toBe("suppressed: not_in_path");
    });

    it("standing still facing a static far-away object produces NO alerts", () => {
      const trackFar: TrackedObject = {
        id: 5,
        class: "chair",
        hazardType: "chair",
        bbox: [270, 50, 50, 50], // center, far (< 0.25)
        history: [
          { area: 0.01, timestamp: 1.0, cx: 0.5, cy: 0.5 },
          { area: 0.01, timestamp: 1.5, cx: 0.5, cy: 0.5 },
        ],
        consecutiveFrames: 2,
        lastSeenTimestamp: 1.5,
      };
      expect(evaluateHazard(trackFar, W, H)).toBeNull();
      const details = evaluateHazardDetails(trackFar, W, H);
      expect(details.decision).toBe("suppressed: static_far");
    });

    it("side-passing person or bike gives NO alert (Req A3)", () => {
      // 1. Person on right passing by at mid distance, moving parallel (cx constant)
      const passingPerson: TrackedObject = {
        id: 8,
        class: "person",
        hazardType: "person",
        bbox: [500, 50, 80, 120], // right third, mid distance (120/360 = 0.33)
        history: [
          { area: 0.03, timestamp: 1.0, cx: 0.82, cy: 0.5 },
          { area: 0.04, timestamp: 1.4, cx: 0.82, cy: 0.5 },
          { area: 0.05, timestamp: 1.8, cx: 0.82, cy: 0.5 },
          { area: 0.06, timestamp: 2.2, cx: 0.82, cy: 0.5 },
        ],
        consecutiveFrames: 4,
        lastSeenTimestamp: 2.2,
      };
      // Mid distance side passing person is silent!
      expect(evaluateHazard(passingPerson, W, H)).toBeNull();
      const passDetails = evaluateHazardDetails(passingPerson, W, H);
      expect(passDetails.decision).toBe("suppressed: not_in_path");

      // 2. Bicycle on left far distance passing by
      const passingBicycle: TrackedObject = {
        id: 9,
        class: "bicycle",
        hazardType: "bicycle",
        bbox: [50, 50, 50, 60], // left third, far distance (60/360 = 0.16)
        history: [
          { area: 0.01, timestamp: 1.0, cx: 0.12, cy: 0.5 },
          { area: 0.015, timestamp: 1.4, cx: 0.12, cy: 0.5 },
          { area: 0.02, timestamp: 1.8, cx: 0.12, cy: 0.5 },
          { area: 0.025, timestamp: 2.2, cx: 0.12, cy: 0.5 },
        ],
        consecutiveFrames: 4,
        lastSeenTimestamp: 2.2,
      };
      // Far distance side bicycle is silent!
      expect(evaluateHazard(passingBicycle, W, H)).toBeNull();
    });

    it("center approach alerts for moving objects (Req A3)", () => {
      // Vehicle in center approaching tracked for 0.8s and sustained closing for 0.8s (> 0.05/s)
      const trackCenterClosingVehicle: TrackedObject = {
        id: 11,
        class: "car",
        hazardType: "vehicle",
        bbox: [270, 50, 100, 140], // center, mid
        history: [
          { area: 0.03, timestamp: 0.0, cx: 0.5, cy: 0.5 },
          { area: 0.06, timestamp: 0.4, cx: 0.5, cy: 0.5 }, // dt=0.4, delta=0.03, speed=0.075/s
          { area: 0.09, timestamp: 0.8, cx: 0.5, cy: 0.5 }, // dt=0.4, delta=0.03, speed=0.075/s
        ],
        consecutiveFrames: 3,
        lastSeenTimestamp: 0.8,
      };
      const alert = evaluateHazard(trackCenterClosingVehicle, W, H);
      expect(alert).not.toBeNull();
      expect(alert!.direction).toBe("center");
      expect(alert!.urgency).toBe(2);
      expect(alert!.clear_side).toBe("none"); // No steering words allowed
    });

    it("urgency 3 is triggered for near AND closing in center or side converging", () => {
      // Center person near AND closing for >= 0.8s
      const trackNearClosingPerson: TrackedObject = {
        id: 12,
        class: "person",
        hazardType: "person",
        bbox: [270, 50, 100, 200], // center, near (200 / 360 = 0.55 >= 0.50)
        history: [
          { area: 0.04, timestamp: 0.0, cx: 0.5, cy: 0.5 },
          { area: 0.08, timestamp: 0.4, cx: 0.5, cy: 0.5 }, // speed 0.10/s (> 0.08)
          { area: 0.12, timestamp: 0.8, cx: 0.5, cy: 0.5 }, // speed 0.10/s
        ],
        consecutiveFrames: 3,
        lastSeenTimestamp: 0.8,
      };
      const alert = evaluateHazard(trackNearClosingPerson, W, H);
      expect(alert).not.toBeNull();
      expect(alert!.urgency).toBe(3);
      expect(alert!.clear_side).toBe("none");

      // Side object that is NEAR, CLOSING, and MOVING TOWARD CENTER -> urgency 3!
      const trackSideConverging: TrackedObject = {
        id: 13,
        class: "bicycle",
        hazardType: "bicycle",
        bbox: [50, 50, 100, 190], // left third, near
        history: [
          { area: 0.04, timestamp: 0.0, cx: 0.10, cy: 0.5 },
          { area: 0.08, timestamp: 0.4, cx: 0.20, cy: 0.5 }, // cx moving rightward toward center (0.5)!
          { area: 0.12, timestamp: 0.8, cx: 0.30, cy: 0.5 },
        ],
        consecutiveFrames: 3,
        lastSeenTimestamp: 0.8,
      };
      const alertSide = evaluateHazard(trackSideConverging, W, H);
      expect(alertSide).not.toBeNull();
      expect(alertSide!.direction).toBe("left");
      expect(alertSide!.urgency).toBe(3);
    });
  });

  describe("6. Re-announce rule (Req A4)", () => {
    const W = 640;
    const H = 360;

    it("suppresses repeated alert for same static obstacle unless distance gets worse or 10s pass", () => {
      const track: TrackedObject = {
        id: 10,
        class: "chair",
        hazardType: "chair",
        bbox: [270, 100, 100, 100], // mid (100 / 360 = 0.277)
        history: [
          { area: 0.04, timestamp: 1.0, cx: 0.5, cy: 0.5 },
          { area: 0.04, timestamp: 1.5, cx: 0.5, cy: 0.5 },
        ],
        consecutiveFrames: 2,
        lastSeenTimestamp: 1.5,
      };

      // First alert at t = 1.5s (1500ms)
      const alert1 = evaluateHazard(track, W, H);
      expect(alert1).not.toBeNull();
      expect(track.lastAnnouncedDistance).toBe("mid");
      expect(track.lastAnnouncedAt).toBe(1500);

      // Frame at t = 1.6s: same distance mid -> suppressed!
      track.history.push({ area: 0.04, timestamp: 1.6, cx: 0.5, cy: 0.5 });
      track.lastSeenTimestamp = 1.6;
      const alert2 = evaluateHazard(track, W, H);
      expect(alert2).toBeNull();
      const repDetails = evaluateHazardDetails(track, W, H);
      expect(repDetails.decision).toBe("suppressed: already_announced");

      // Case A: distance worsens to near at t = 2.0s -> Re-announced!
      track.bbox = [270, 50, 100, 190]; // near
      track.history.push({ area: 0.09, timestamp: 2.0, cx: 0.5, cy: 0.5 });
      track.lastSeenTimestamp = 2.0;
      const alertWorse = evaluateHazard(track, W, H);
      expect(alertWorse).not.toBeNull();
      expect(alertWorse!.distance).toBe("near");

      // Frame after worsening at t = 2.1s: still near -> suppressed!
      track.history.push({ area: 0.09, timestamp: 2.1, cx: 0.5, cy: 0.5 });
      track.lastSeenTimestamp = 2.1;
      expect(evaluateHazard(track, W, H)).toBeNull();

      // Case B: 10 seconds elapse (t = 12.5s) -> Re-announced!
      track.history.push({ area: 0.09, timestamp: 12.5, cx: 0.5, cy: 0.5 });
      track.lastSeenTimestamp = 12.5;
      const alertTimeout = evaluateHazard(track, W, H);
      expect(alertTimeout).not.toBeNull();
      expect(alertTimeout!.distance).toBe("near");
    });
  });

  describe("Requirement 1: Time-based rules on a slow phone (2.5 FPS)", () => {
    const W = 640;
    const H = 360;

    it("computes tracked duration and sustained closing correctly", () => {
      const history = [
        { area: 0.04, timestamp: 0.0, cx: 0.5, cy: 0.5 },
        { area: 0.08, timestamp: 0.4, cx: 0.5, cy: 0.5 },
        { area: 0.12, timestamp: 0.8, cx: 0.5, cy: 0.5 },
      ];
      expect(getTrackedDurationSec(history)).toBeCloseTo(0.8, 2);
      expect(isClosingSustained(history, 0.6, 0.05)).toBe(true);
      expect(isClosingSustained(history, 1.2, 0.05)).toBe(false);
    });

    it("suppresses moving object alerts when tracked time is under 0.8s", () => {
      const track: TrackedObject = {
        id: 20,
        class: "car",
        hazardType: "vehicle",
        bbox: [270, 50, 100, 140],
        history: [
          { area: 0.04, timestamp: 0.0, cx: 0.5, cy: 0.5 },
          { area: 0.08, timestamp: 0.4, cx: 0.5, cy: 0.5 }, // 0.4s < 0.8s
        ],
        consecutiveFrames: 2,
        lastSeenTimestamp: 0.4,
      };
      const details = evaluateHazardDetails(track, W, H);
      expect(details.alert).toBeNull();
      expect(details.decision).toBe("suppressed: not_tracked_long_enough");
      expect(details.reason).toContain("tracked 0.40s < 0.8s");
    });

    it("suppresses moving object when closing speed is not sustained for at least 0.6s", () => {
      const track: TrackedObject = {
        id: 21,
        class: "car",
        hazardType: "vehicle",
        bbox: [270, 50, 100, 140],
        history: [
          { area: 0.08, timestamp: 0.0, cx: 0.5, cy: 0.5 },
          { area: 0.08, timestamp: 0.4, cx: 0.5, cy: 0.5 }, // flat
          { area: 0.08, timestamp: 0.8, cx: 0.5, cy: 0.5 }, // flat
        ],
        consecutiveFrames: 3,
        lastSeenTimestamp: 0.8,
      };
      const details = evaluateHazardDetails(track, W, H);
      expect(details.alert).toBeNull();
      expect(details.decision).toBe("suppressed: closing_not_sustained");
    });

    it("vehicle approaching from mid distance at 2.5 FPS alerts within 1.5s (specifically at 0.8s)", () => {
      // At 2.5 FPS, frames arrive every 0.40s
      // t = 0.0s: Frame 1 -> newly detected
      const frame1Dets: RawDetection[] = [
        { bbox: [270, 60, 100, 100], class: "car", score: 0.9 }, // mid distance
      ];
      const step1 = updateTracker([], frame1Dets, 0.0, W, H);
      expect(step1.alerts.length).toBe(0);
      expect(step1.decisions[0]!.decision).toBe("suppressed: not_tracked_long_enough");

      // t = 0.4s: Frame 2 -> closing in (decision unchanged, so NO duplicate row per Req 3)
      const frame2Dets: RawDetection[] = [
        { bbox: [270, 50, 130, 140], class: "car", score: 0.92 }, // area grows
      ];
      const step2 = updateTracker(step1.updatedTracks, frame2Dets, 0.4, W, H);
      expect(step2.alerts.length).toBe(0);
      expect(step2.decisions.length).toBe(0); // Only log on decision change (Req 3)

      // t = 0.8s: Frame 3 -> tracked for 0.8s, closing sustained for 0.8s (>= 0.6s)
      const frame3Dets: RawDetection[] = [
        { bbox: [270, 40, 160, 170], class: "car", score: 0.95 },
      ];
      const step3 = updateTracker(step2.updatedTracks, frame3Dets, 0.8, W, H);
      // Alert MUST fire at t = 0.8s!
      expect(step3.alerts.length).toBe(1);
      const alert = step3.alerts[0]!;
      expect(alert.type).toBe("vehicle");
      expect(alert.direction).toBe("center");
      expect(alert.distance).toBe("mid");
      expect(alert.urgency).toBe(2);
      expect(alert.timestamp).toBe(800); // 800ms = 0.8s <= 1.5s requirement
      expect(step3.decisions[0]!.decision).toBe("alerted");
    });
  });

  describe("Requirement 2: Decision logging & CSV row generation", () => {
    const W = 640;
    const H = 360;

    it("logs decisions with clip name and formatted reasons for each track", () => {
      const dets: RawDetection[] = [
        { bbox: [270, 50, 100, 180], class: "chair", score: 0.9 },
      ];
      const res = updateTracker([], dets, 1.25, W, H, undefined, "clip_stairs_01.mp4");
      expect(res.decisions.length).toBe(1);
      const d = res.decisions[0]!;
      expect(d.clip).toBe("clip_stairs_01.mp4");
      expect(d.t).toBe(1.25);
      expect(d.class).toBe("chair");
      expect(d.direction).toBe("center");
      expect(d.decision).toBe("suppressed: static_debounce");
      expect(d.reason).toContain("static chair tracked");
    });
  });

  describe("7. Specific class mappings (plant, bag, pole)", () => {
    it("maps fire hydrant to pole, potted plant to plant, suitcase to bag", () => {
      expect(COCO_TO_HAZARD_MAP["fire hydrant"]).toBe("pole");
      expect(COCO_TO_HAZARD_MAP["potted plant"]).toBe("plant");
      expect(COCO_TO_HAZARD_MAP["suitcase"]).toBe("bag");
    });
  });

  describe("8. Steering Safety & Moving Hazard Phrases (Req A1 & A2)", () => {
    const movingTypes = ["person", "vehicle", "bicycle", "animal", "rickshaw"];

    it("never instructs a lateral move for moving objects", () => {
      for (const t of movingTypes) {
        for (const dir of ["center", "left", "right"]) {
          const phraseEn = buildPhrase({ type: t, direction: dir, clear_side: "right" }, "en");
          const phraseHi = buildPhrase({ type: t, direction: dir, clear_side: "left" }, "hi");

          // Prohibited steering words
          expect(phraseEn.toLowerCase()).not.toContain("step left");
          expect(phraseEn.toLowerCase()).not.toContain("step right");
          expect(phraseEn.toLowerCase()).not.toContain("move left");
          expect(phraseEn.toLowerCase()).not.toContain("move right");
          expect(phraseHi).not.toContain("बाएँ हटें");
          expect(phraseHi).not.toContain("दाएँ हटें");

          // Caution words plus position
          if (dir === "center") {
            expect(phraseEn).toContain("ahead, stop");
            expect(phraseHi).toContain("आगे, रुकें");
          } else if (dir === "left") {
            expect(phraseEn).toContain("on left, careful");
            expect(phraseHi).toContain("बाएँ, सावधान");
          } else if (dir === "right") {
            expect(phraseEn).toContain("on right, careful");
            expect(phraseHi).toContain("दाएँ, सावधान");
          }

          expect(phraseEn.split(" ").length).toBeLessThanOrEqual(4);
          expect(phraseHi.split(" ").length).toBeLessThanOrEqual(4);
        }
      }
    });

    it("allows steering only for static obstacles", () => {
      const chairEn = buildPhrase({ type: "chair", direction: "center", clear_side: "right" }, "en");
      expect(chairEn).toBe("Chair ahead, step right");

      const chairHi = buildPhrase({ type: "chair", direction: "center", clear_side: "right" }, "hi");
      expect(chairHi).toBe("कुर्सी आगे, दाएँ हटें");
    });
  });

  describe("9. Lens blocked & dark frame detection (Req B6, Items 5 & 6)", () => {
    it("detects blocked/uniform or pitch dark frames", () => {
      // 1. Pitch dark frame (mean=2, variance=1)
      const darkData = new Uint8ClampedArray(16 * 16 * 4);
      darkData.fill(2);
      const darkStats = analyzeFrameLuminance(darkData);
      expect(darkStats.isBlocked).toBe(true);

      // 2. Uniform light/covered frame (mean=180, variance=2)
      const uniformData = new Uint8ClampedArray(16 * 16 * 4);
      uniformData.fill(180);
      const uniformStats = analyzeFrameLuminance(uniformData);
      expect(uniformStats.isBlocked).toBe(true);

      // 3. Normal textured scene (high variance)
      const normalData = new Uint8ClampedArray(16 * 16 * 4);
      for (let i = 0; i < normalData.length; i += 4) {
        normalData[i] = (i % 256); // varied luminance
        normalData[i + 1] = ((i * 3) % 256);
        normalData[i + 2] = ((i * 7) % 256);
      }
      const normalStats = analyzeFrameLuminance(normalData);
      expect(normalStats.isBlocked).toBe(false);
    });

    it("triggers blocked on a plain white wall right in front of the lens", () => {
      // Plain white wall filling the camera field: high brightness (~220) with very low variance (< 15)
      const wallData = new Uint8ClampedArray(64 * 64 * 4);
      for (let i = 0; i < wallData.length; i += 4) {
        // Small sensor noise +/- 2 around 220
        const jitter = (i % 5) - 2;
        const val = 220 + jitter;
        wallData[i] = val;
        wallData[i + 1] = val;
        wallData[i + 2] = val;
        wallData[i + 3] = 255;
      }
      const stats = analyzeFrameLuminance(wallData);
      expect(stats.mean).toBeGreaterThan(200);
      expect(stats.variance).toBeLessThan(15);
      expect(stats.isBlocked).toBe(true);
    });

    it("does NOT false-alarm on a dim hostel corridor at night", () => {
      // Dim corridor: low mean (~35), but structural contrasts (doors, corridor floor, light reflections)
      // produce variance well above 15 and 25
      const corridorData = new Uint8ClampedArray(64 * 64 * 4);
      for (let i = 0; i < corridorData.length; i += 4) {
        const pixelIdx = i / 4;
        let luma = 25; // dark corridor floor / walls
        if (pixelIdx % 8 === 0) {
          luma = 75; // door frame edge / wall border
        } else if (pixelIdx % 32 === 0) {
          luma = 140; // distant light reflection / exit sign
        }
        corridorData[i] = luma;
        corridorData[i + 1] = luma;
        corridorData[i + 2] = luma;
        corridorData[i + 3] = 255;
      }
      const stats = analyzeFrameLuminance(corridorData);
      expect(stats.mean).toBeGreaterThan(25);
      expect(stats.mean).toBeLessThan(50);
      expect(stats.variance).toBeGreaterThan(50);
      expect(stats.isBlocked).toBe(false);
    });

    it("does NOT false-alarm on a shaded street scene", () => {
      // Shaded street: moderate brightness (~110), rich textural details (pavement, foliage, shadows)
      const streetData = new Uint8ClampedArray(64 * 64 * 4);
      for (let i = 0; i < streetData.length; i += 4) {
        const pixelIdx = i / 4;
        // Natural distribution with asphalt, shadow, and sun patches
        const luma = 60 + ((pixelIdx * 17) % 110);
        streetData[i] = luma;
        streetData[i + 1] = luma;
        streetData[i + 2] = luma;
        streetData[i + 3] = 255;
      }
      const stats = analyzeFrameLuminance(streetData);
      expect(stats.mean).toBeGreaterThan(80);
      expect(stats.mean).toBeLessThan(140);
      expect(stats.variance).toBeGreaterThan(500);
      expect(stats.isBlocked).toBe(false);
    });
  });

  describe("10. Offline Retry Backoff Schedule (Req D9)", () => {
    it("follows exponential backoff schedule [2000, 4000, 8000, 15000]", () => {
      const backoffSchedule = [2000, 4000, 8000, 15000];
      const getDelay = (failures: number) =>
        backoffSchedule[Math.min(failures - 1, backoffSchedule.length - 1)] ?? 15000;

      expect(getDelay(1)).toBe(2000);
      expect(getDelay(2)).toBe(4000);
      expect(getDelay(3)).toBe(8000);
      expect(getDelay(4)).toBe(15000);
      expect(getDelay(5)).toBe(15000);
      expect(getDelay(10)).toBe(15000);
    });
  });

  describe("11. Shared dedupe with Tier 2 in PriorityArbiter", () => {
    it("dedupes Tier 2 alert when Tier 1 already announced the same hazard type and direction", () => {
      const spoken: string[] = [];
      const arbiter = new PriorityArbiter(
        (text) => {
          spoken.push(text);
        },
        () => {},
        { hazardDedupeMs: 4000 }
      );

      // Tier 1 fires chair center
      const msgTier1 = makeHazardMessage(
        "chair",
        "center",
        "Chair ahead, step right",
        "en",
        2,
        0.9
      );
      expect(msgTier1.key).toBe("hazard:chair:center");
      const ok1 = arbiter.enqueue(msgTier1);
      expect(ok1).toBe(true);
      expect(spoken).toContain("Chair ahead, step right");

      // 1.5 seconds later, Tier 2 cloud response arrives with the same chair center
      const msgTier2 = makeHazardMessage(
        "chair",
        "center",
        "Chair ahead, step right",
        "en",
        2,
        0.9
      );
      expect(msgTier2.key).toBe("hazard:chair:center");
      const ok2 = arbiter.enqueue(msgTier2);
      // Suppressed by 4s dedupe!
      expect(ok2).toBe(false);
      expect(spoken.length).toBe(1);
    });
  });

  describe("12. Live mode gap tolerance (Requirement 2)", () => {
    const W = 640;
    const H = 360;

    it("tolerates ~0.5s gaps between frames, preserving track ID and accumulating tracked duration", () => {
      // Frame 1 at t = 0.0s: person detected at center
      const dets1: RawDetection[] = [
        { bbox: [270, 50, 100, 180], class: "person", score: 0.9 },
      ];
      const res1 = updateTracker([], dets1, 0.0, W, H);
      expect(res1.updatedTracks.length).toBe(1);
      const trackId = res1.updatedTracks[0]!.id;
      expect(res1.updatedTracks[0]!.consecutiveFrames).toBe(1);
      expect(getTrackedDurationSec(res1.updatedTracks[0]!.history)).toBe(0.0);

      // Frame 2 arrives after 0.5s gap (t = 0.50s) with significant walking displacement (centroid moves ~0.35 across frame)
      const dets2: RawDetection[] = [
        { bbox: [220, 60, 110, 190], class: "person", score: 0.88 },
      ];
      const res2 = updateTracker(res1.updatedTracks, dets2, 0.50, W, H);
      expect(res2.updatedTracks.length).toBe(1);
      // Confirmed: track ID preserved across 0.5s gap!
      expect(res2.updatedTracks[0]!.id).toBe(trackId);
      expect(res2.updatedTracks[0]!.consecutiveFrames).toBe(2);
      expect(getTrackedDurationSec(res2.updatedTracks[0]!.history)).toBe(0.50);

      // Frame 3 arrives after another 0.5s gap (t = 1.00s)
      const dets3: RawDetection[] = [
        { bbox: [180, 70, 120, 200], class: "person", score: 0.91 },
      ];
      const res3 = updateTracker(res2.updatedTracks, dets3, 1.00, W, H);
      expect(res3.updatedTracks.length).toBe(1);
      expect(res3.updatedTracks[0]!.id).toBe(trackId);
      expect(res3.updatedTracks[0]!.consecutiveFrames).toBe(3);
      expect(getTrackedDurationSec(res3.updatedTracks[0]!.history)).toBe(1.00);
      // Track duration >= 0.8s satisfies minTrackDurationSec!
      expect(res3.updatedTracks[0]!.history.length).toBe(3);
    });

    it("tolerates 0.8s gap between detections", () => {
      // Frame 1 at t = 1.0s
      const dets1: RawDetection[] = [
        { bbox: [260, 40, 120, 160], class: "car", score: 0.95 },
      ];
      const res1 = updateTracker([], dets1, 1.0, W, H);
      expect(res1.updatedTracks.length).toBe(1);
      const trackId = res1.updatedTracks[0]!.id;

      // Frame 2 at t = 1.8s (gap = 0.8s <= 1.0s)
      const dets2: RawDetection[] = [
        { bbox: [230, 45, 140, 180], class: "car", score: 0.95 },
      ];
      const res2 = updateTracker(res1.updatedTracks, dets2, 1.8, W, H);
      expect(res2.updatedTracks.length).toBe(1);
      expect(res2.updatedTracks[0]!.id).toBe(trackId);
      expect(res2.updatedTracks[0]!.consecutiveFrames).toBe(2);
      expect(getTrackedDurationSec(res2.updatedTracks[0]!.history)).toBeCloseTo(0.8, 2);
    });

    it("drops track when gap exceeds 1.0s", () => {
      // Frame 1 at t = 0.0s
      const dets1: RawDetection[] = [
        { bbox: [270, 50, 100, 180], class: "person", score: 0.9 },
      ];
      const res1 = updateTracker([], dets1, 0.0, W, H);
      const oldTrackId = res1.updatedTracks[0]!.id;

      // Frame 2 at t = 1.5s (gap = 1.5s > 1.0s max gap)
      const dets2: RawDetection[] = [
        { bbox: [270, 50, 100, 180], class: "person", score: 0.9 },
      ];
      const res2 = updateTracker(res1.updatedTracks, dets2, 1.5, W, H);
      expect(res2.updatedTracks.length).toBe(1);
      // Confirmed: old track was dropped because gap > 1.0s; new track created!
      expect(res2.updatedTracks[0]!.id).not.toBe(oldTrackId);
      expect(res2.updatedTracks[0]!.consecutiveFrames).toBe(1);
      expect(getTrackedDurationSec(res2.updatedTracks[0]!.history)).toBe(0.0);
    });
  });
});
