import { DEFAULT_TIER1_CONFIG, MOVING_CLASSES } from "./config";
import {
  BBox,
  Direction,
  Distance,
  FrameLuminanceStats,
  RawDetection,
  Tier1Alert,
  Tier1Config,
  Tier1HazardType,
  TrackDecisionLog,
  TrackPoint,
  TrackedObject,
} from "./types";
import { COCO_TO_HAZARD_MAP } from "./config";

/** Compute horizontal third direction from bounding box center. */
export function computeDirection(bbox: BBox, frameWidth: number): Direction {
  if (frameWidth <= 0) return "center";
  const [x, , width] = bbox;
  const centerX = x + width / 2;
  const normX = centerX / frameWidth;

  if (normX < 1 / 3) return "left";
  if (normX > 2 / 3) return "right";
  return "center";
}

/** Compute proximity from bounding box height fraction. */
export function computeProximity(
  bbox: BBox,
  frameHeight: number,
  config: Tier1Config = DEFAULT_TIER1_CONFIG
): Distance {
  if (frameHeight <= 0) return "far";
  const [, , , height] = bbox;
  const frac = height / frameHeight;

  if (frac >= config.nearThreshold) return "near";
  if (frac >= config.midThreshold) return "mid";
  return "far";
}

/** Compute Intersection over Union between two bounding boxes. */
export function computeIoU(a: BBox, b: BBox): number {
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;

  const x1 = Math.max(ax, bx);
  const y1 = Math.max(ay, by);
  const x2 = Math.min(ax + aw, bx + bw);
  const y2 = Math.min(ay + ah, by + bh);

  const interWidth = Math.max(0, x2 - x1);
  const interHeight = Math.max(0, y2 - y1);
  const interArea = interWidth * interHeight;

  const areaA = aw * ah;
  const areaB = bw * bh;
  const unionArea = areaA + areaB - interArea;

  if (unionArea <= 0) return 0;
  return interArea / unionArea;
}

/** Compute normalized Euclidean distance between centroids of two bounding boxes. */
export function computeCentroidDistance(
  a: BBox,
  b: BBox,
  frameWidth: number,
  frameHeight: number
): number {
  if (frameWidth <= 0 || frameHeight <= 0) return 1.0;
  const acx = (a[0] + a[2] / 2) / frameWidth;
  const acy = (a[1] + a[3] / 2) / frameHeight;
  const bcx = (b[0] + b[2] / 2) / frameWidth;
  const bcy = (b[1] + b[3] / 2) / frameHeight;

  return Math.hypot(acx - bcx, acy - bcy);
}

/** Compute total time an object has been tracked in seconds. */
export function getTrackedDurationSec(history: TrackPoint[]): number {
  if (history.length < 2) return 0;
  return history[history.length - 1]!.timestamp - history[0]!.timestamp;
}

/**
 * Compute smoothed closing speed (normalized area growth per second)
 * over the last time window (default 0.6 seconds) using frame timestamps.
 */
export function computeClosingSpeedPerSec(
  history: TrackPoint[],
  windowSec: number = 0.6
): number {
  if (history.length < 2) return 0;

  if (history.length === 2) {
    const p0 = history[0]!;
    const p1 = history[1]!;
    const dt = p1.timestamp - p0.timestamp;
    if (dt <= 0) return 0;
    return (p1.area - p0.area) / dt;
  }

  const latest = history[history.length - 1]!;
  let earliest = history[0]!;
  for (let i = history.length - 2; i >= 0; i--) {
    earliest = history[i]!;
    if (latest.timestamp - earliest.timestamp >= windowSec) {
      break;
    }
  }

  const dt = latest.timestamp - earliest.timestamp;
  if (dt <= 0) return 0;
  return (latest.area - earliest.area) / dt;
}

/**
 * Time-based sustained closing check (Requirement 1):
 * Verifies that the object has continuously grown with positive rate >= threshold
 * over at least minDurationSec (default 0.6s).
 */
export function isClosingSustained(
  history: TrackPoint[],
  minDurationSec: number = 0.6,
  threshold: number = 0.05
): boolean {
  if (history.length < 2) return false;
  const latest = history[history.length - 1]!;
  const earliest = history[0]!;
  const totalDuration = latest.timestamp - earliest.timestamp;
  if (totalDuration < minDurationSec) return false;

  // Find slice covering at least minDurationSec
  let startIdx = 0;
  for (let i = history.length - 2; i >= 0; i--) {
    if (latest.timestamp - history[i]!.timestamp >= minDurationSec) {
      startIdx = i;
      break;
    }
  }

  const windowPoints = history.slice(startIdx);
  if (windowPoints.length < 2) return false;

  const pStart = windowPoints[0]!;
  const pEnd = windowPoints[windowPoints.length - 1]!;
  const dt = pEnd.timestamp - pStart.timestamp;
  if (dt <= 0) return false;

  const netSpeed = (pEnd.area - pStart.area) / dt;
  if (netSpeed < threshold) return false;

  // Verify non-retreating continuous closing within the window
  for (let i = 1; i < windowPoints.length; i++) {
    const pPrev = windowPoints[i - 1]!;
    const pCurr = windowPoints[i]!;
    if (pCurr.timestamp - pPrev.timestamp <= 0) continue;
    // Allow slight sensor noise (up to 5% shrinkage), but no major retreat
    if (pCurr.area < pPrev.area * 0.95) return false;
  }

  return true;
}

/** Check if closing speed is above threshold for 3 consecutive frame-to-frame steps (legacy compatibility). */
export function hasThreeConsecutiveClosingSteps(
  history: TrackPoint[],
  threshold: number
): boolean {
  if (history.length < 4) return false;
  const n = history.length;
  for (let k = 1; k <= 3; k++) {
    const pCurr = history[n - k]!;
    const pPrev = history[n - k - 1]!;
    const dt = pCurr.timestamp - pPrev.timestamp;
    if (dt <= 0) return false;
    const speed = (pCurr.area - pPrev.area) / dt;
    if (speed < threshold) return false;
  }
  return true;
}

/** Check if a side object is moving toward the center of the frame. */
export function isMovingTowardCenter(
  history: TrackPoint[],
  frameWidth: number
): boolean {
  if (history.length < 2) return false;
  const pCurr = history[history.length - 1]!;
  const pPrev = history[history.length - 2]!;
  const center = pCurr.cx <= 1.0 ? 0.5 : frameWidth / 2;
  const currDist = Math.abs(pCurr.cx - center);
  const prevDist = Math.abs(pPrev.cx - center);
  return currDist < prevDist;
}

/** Get class-specific closing threshold from config. */
export function getClosingThreshold(
  hazardType: Tier1HazardType,
  config: Tier1Config = DEFAULT_TIER1_CONFIG
): number {
  const perClass = config.perClassClosingThreshold ?? {};
  return perClass[hazardType] ?? perClass.default ?? config.closingThresholdPerSec;
}

/** Analyze frame luminance variance and mean to detect blocked or dark frames. */
export function analyzeFrameLuminance(imageData: Uint8ClampedArray): FrameLuminanceStats {
  const n = imageData.length / 4;
  if (n === 0) return { mean: 0, variance: 0, isBlocked: true };

  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < imageData.length; i += 4) {
    const y =
      0.299 * (imageData[i] ?? 0) +
      0.587 * (imageData[i + 1] ?? 0) +
      0.114 * (imageData[i + 2] ?? 0);
    sum += y;
    sumSq += y * y;
  }
  const mean = sum / n;
  const variance = sumSq / n - mean * mean;

  // Low variance (< 15) indicates uniform blockage (e.g. finger/pocket).
  // Low mean (< 15) with low variance indicates pitch darkness.
  const isBlocked = variance < 15 || (mean < 15 && variance < 25);
  return { mean, variance, isBlocked };
}

const DISTANCE_SEVERITY: Record<Distance, number> = {
  far: 1,
  mid: 2,
  near: 3,
};

/** Compute avoid direction based on hazard direction for static obstacles. */
export function computeClearSide(direction: Direction): "left" | "right" | "none" {
  if (direction === "left") return "right";
  if (direction === "right") return "left";
  return "right";
}

export interface HazardEvaluationDetails {
  alert: Tier1Alert | null;
  decision: "alerted" | `suppressed: ${string}`;
  rule: string;
  reason: string;
}

/**
 * Evaluate a single tracked object against time-based path-relevance, closing speed,
 * and re-announce rules (Requirement 1 & 2). Returns full decision details.
 */
export function evaluateHazardDetails(
  tracked: TrackedObject,
  frameWidth: number,
  frameHeight: number,
  config: Tier1Config = DEFAULT_TIER1_CONFIG
): HazardEvaluationDetails {
  const direction = computeDirection(tracked.bbox, frameWidth);
  const distance = computeProximity(tracked.bbox, frameHeight, config);
  const minClosingDur = config.minClosingDurationSec ?? 0.6;
  const closingSpeed = computeClosingSpeedPerSec(tracked.history, minClosingDur);
  const isMovingClass = MOVING_CLASSES.has(tracked.hazardType);
  const h_frac = frameHeight > 0 ? Math.round((tracked.bbox[3] / frameHeight) * 100) / 100 : 0;
  const trackedDuration = getTrackedDurationSec(tracked.history);

  let urgency: 0 | 1 | 2 | 3 = 0;
  let ruleFired = "none";

  if (isMovingClass) {
    // MOVING OBJECT SAFETY (Requirement 1: time-based rules)
    // 1. Must be tracked for at least minTrackDurationSec (default 0.8 s)
    const minTrackDur = config.minTrackDurationSec ?? 0.8;
    if (trackedDuration < minTrackDur) {
      return {
        alert: null,
        decision: "suppressed: not_tracked_long_enough",
        rule: "min_track_duration",
        reason: `${tracked.hazardType} tracked ${trackedDuration.toFixed(2)}s < ${minTrackDur}s`,
      };
    }

    // 2. Position / trajectory check:
    // Center third: alert. Side object: must be near AND moving toward center.
    if (direction !== "center") {
      const movingTowardCenter = isMovingTowardCenter(tracked.history, frameWidth);
      if (distance !== "near" || !movingTowardCenter) {
        return {
          alert: null,
          decision: "suppressed: not_in_path",
          rule: "side_passing_silent",
          reason: `side ${tracked.hazardType} on ${direction} (${distance}) not near/converging`,
        };
      }
    }

    // 3. Closing speed must be sustained for at least minClosingDurationSec (default 0.6 s)
    const threshold = getClosingThreshold(tracked.hazardType, config);
    if (!isClosingSustained(tracked.history, minClosingDur, threshold)) {
      return {
        alert: null,
        decision: "suppressed: closing_not_sustained",
        rule: "closing_sustained",
        reason: `${tracked.hazardType} speed ${closingSpeed.toFixed(2)}/s < ${threshold}/s or not sustained for ${minClosingDur}s`,
      };
    }

    // 4. Urgency assignment
    if (direction === "center") {
      ruleFired = "center_approach";
      if (distance === "near") {
        urgency = 3; // Near and closing -> urgency 3
      } else if (distance === "mid") {
        urgency = 2; // Mid closing -> urgency 2
      } else {
        urgency = closingSpeed > config.fastClosingThresholdPerSec ? 2 : 1;
      }
    } else {
      ruleFired = "side_near_closing_converging";
      urgency = 3;
    }
  } else {
    // STATIC OBSTACLE (chair, table, bench, pole, plant, bag, etc.)
    // 1. Debounce: time-based (default 0.4s or at least 2 points)
    const staticMinTrack = config.staticMinTrackDurationSec ?? 0.4;
    if (trackedDuration < staticMinTrack || tracked.history.length < 2) {
      return {
        alert: null,
        decision: "suppressed: static_debounce",
        rule: "static_debounce",
        reason: `static ${tracked.hazardType} tracked ${trackedDuration.toFixed(2)}s < ${staticMinTrack}s`,
      };
    }

    // 2. Path relevance: Static obstacle matters ONLY if in center third
    if (direction !== "center") {
      return {
        alert: null,
        decision: "suppressed: not_in_path",
        rule: "static_side_silent",
        reason: `static ${tracked.hazardType} on ${direction} (outside center path)`,
      };
    }

    // 3. Proximity
    if (distance === "near") {
      urgency = 2;
      ruleFired = "static_center_near";
    } else if (distance === "mid") {
      urgency = 2;
      ruleFired = "static_center_mid";
    } else {
      return {
        alert: null,
        decision: "suppressed: static_far",
        rule: "static_far_silent",
        reason: `static ${tracked.hazardType} far in center`,
      };
    }
  }

  // Filter urgency: only urgency 2 and 3 go to arbiter
  if (urgency < 2) {
    return {
      alert: null,
      decision: "suppressed: urgency_too_low",
      rule: "urgency_filter",
      reason: `urgency ${urgency} < 2`,
    };
  }

  const now = tracked.history[tracked.history.length - 1]?.timestamp ?? 0;
  const nowMs = now * 1000;

  // Re-announce rule: announce each tracked object once unless distance worsens or 10s pass
  if (tracked.hasBeenAnnounced && urgency < 3) {
    const gotWorse =
      tracked.lastAnnouncedDistance !== undefined &&
      DISTANCE_SEVERITY[distance] > DISTANCE_SEVERITY[tracked.lastAnnouncedDistance];
    const timeElapsed = nowMs - (tracked.lastAnnouncedAt ?? 0) >= config.reannounceTimeoutMs;
    if (!gotWorse && !timeElapsed) {
      return {
        alert: null,
        decision: "suppressed: already_announced",
        rule: "reannounce_suppression",
        reason: `already announced at ${tracked.lastAnnouncedDistance}, ${(nowMs - (tracked.lastAnnouncedAt ?? 0)) / 1000}s < 10s`,
      };
    }
  }

  tracked.hasBeenAnnounced = true;
  tracked.lastAnnouncedDistance = distance;
  tracked.lastAnnouncedAt = nowMs;

  const reason = `${tracked.hazardType} | h=${h_frac} | v=${Math.round(closingSpeed * 100) / 100}/s | ${direction} | ${trackedDuration.toFixed(2)}s | ${ruleFired}`;

  const alert: Tier1Alert = {
    type: tracked.hazardType,
    direction,
    distance,
    urgency: urgency as 2 | 3,
    clear_side: isMovingClass ? "none" : computeClearSide(direction),
    closingSpeedPerSec: Math.round(closingSpeed * 1000) / 1000,
    timestamp: nowMs,
    confidence: 0.9,
    h_frac,
    framesTracked: tracked.consecutiveFrames,
    ruleFired,
    reason,
    trackedId: tracked.id,
  };

  return {
    alert,
    decision: "alerted",
    rule: ruleFired,
    reason,
  };
}

/**
 * Evaluate a single tracked object against path-relevance, closing speed,
 * and re-announce rules. Returns a Tier1Alert if urgency is 2 or 3, else null.
 */
export function evaluateHazard(
  tracked: TrackedObject,
  frameWidth: number,
  frameHeight: number,
  config: Tier1Config = DEFAULT_TIER1_CONFIG
): Tier1Alert | null {
  return evaluateHazardDetails(tracked, frameWidth, frameHeight, config).alert;
}

let nextTrackId = 1;
export function resetTrackIdCounter(): void {
  nextTrackId = 1;
}

/**
 * Match detections across frames with simple IoU + centroid distance tracker.
 */
export function updateTracker(
  existingTracks: TrackedObject[],
  detections: RawDetection[],
  timestampSec: number,
  frameWidth: number,
  frameHeight: number,
  config: Tier1Config = DEFAULT_TIER1_CONFIG,
  clipName: string = "live"
): {
  updatedTracks: TrackedObject[];
  alerts: Tier1Alert[];
  decisions: TrackDecisionLog[];
} {
  const updatedTracks: TrackedObject[] = [];
  const unmatchedDetections = [...detections];
  const frameArea = Math.max(1, frameWidth * frameHeight);

  // Match existing tracks to detections of the same class
  for (const track of existingTracks) {
    const gap = Math.max(0.01, timestampSec - track.lastSeenTimestamp);
    // Maximum gap of 1.0 s before a track is dropped (Requirement 2)
    if (gap > 1.0) {
      continue;
    }

    let bestMatchIdx = -1;
    let bestScore = -1;

    // Scale centroid distance and IoU threshold according to the gap (nominal gap 0.25s)
    const nominalInterval = 0.25;
    const gapScale = Math.max(1.0, gap / nominalInterval);
    const effectiveCentroidDistThreshold = Math.min(0.65, config.centroidDistanceThreshold * gapScale);
    const effectiveIouThreshold = Math.max(0.05, config.iouMatchThreshold / gapScale);

    for (let i = 0; i < unmatchedDetections.length; i++) {
      const det = unmatchedDetections[i]!;
      if (det.class !== track.class) continue;

      const iou = computeIoU(track.bbox, det.bbox);
      const centroidDist = computeCentroidDistance(track.bbox, det.bbox, frameWidth, frameHeight);

      if (iou >= effectiveIouThreshold || centroidDist <= effectiveCentroidDistThreshold) {
        // Combined match score (higher IoU and lower distance scaled to gap)
        const score = iou + Math.max(0, 1.0 - centroidDist / gapScale);
        if (score > bestScore) {
          bestScore = score;
          bestMatchIdx = i;
        }
      }
    }

    if (bestMatchIdx >= 0) {
      const match = unmatchedDetections.splice(bestMatchIdx, 1)[0]!;
      const normArea = (match.bbox[2] * match.bbox[3]) / frameArea;
      const cx = (match.bbox[0] + match.bbox[2] / 2) / frameWidth;
      const cy = (match.bbox[1] + match.bbox[3] / 2) / frameHeight;

      const newHistory = [...track.history, { area: normArea, timestamp: timestampSec, cx, cy }];
      // Keep up to 10 recent points
      if (newHistory.length > 10) newHistory.shift();

      track.bbox = match.bbox;
      track.history = newHistory;
      track.consecutiveFrames += 1;
      track.lastSeenTimestamp = timestampSec;

      updatedTracks.push(track);
    } else {
      // Retain track for up to 1.0 second before dropping
      if (gap <= 1.0) {
        updatedTracks.push(track);
      }
    }
  }

  // Create new tracks for remaining detections
  for (const det of unmatchedDetections) {
    const hazardType = COCO_TO_HAZARD_MAP[det.class] ?? "other";
    const normArea = (det.bbox[2] * det.bbox[3]) / frameArea;
    const cx = (det.bbox[0] + det.bbox[2] / 2) / frameWidth;
    const cy = (det.bbox[1] + det.bbox[3] / 2) / frameHeight;

    const newTrack: TrackedObject = {
      id: nextTrackId++,
      class: det.class,
      hazardType,
      bbox: det.bbox,
      history: [{ area: normArea, timestamp: timestampSec, cx, cy }],
      consecutiveFrames: 1,
      lastSeenTimestamp: timestampSec,
    };
    updatedTracks.push(newTrack);
  }

  // Evaluate hazards for active tracks and record per-frame decisions (Requirement 2)
  const alerts: Tier1Alert[] = [];
  const decisions: TrackDecisionLog[] = [];

  for (const track of updatedTracks) {
    // Only evaluate tracks observed in current frame
    if (track.lastSeenTimestamp === timestampSec) {
      const evalRes = evaluateHazardDetails(track, frameWidth, frameHeight, config);
      if (evalRes.alert) {
        alerts.push(evalRes.alert);
      }
      // Log once per tracked object per decision change, not per frame (Req 3)
      if (track.lastDecision !== evalRes.decision) {
        track.lastDecision = evalRes.decision;
        decisions.push({
          id: `${timestampSec.toFixed(2)}_${track.id}_${track.hazardType}_${evalRes.decision.replace(/[^a-zA-Z0-9]/g, "_")}`,
          clip: clipName,
          t: Math.round(timestampSec * 100) / 100,
          sample_time: Math.round(timestampSec * 100) / 100,
          class: track.hazardType,
          direction: computeDirection(track.bbox, frameWidth),
          decision: evalRes.decision,
          reason: evalRes.reason,
          label: "",
          trackId: track.id,
        });
      }
    }
  }

  return { updatedTracks, alerts, decisions };
}
