/** Types for Tier 1 on-device detector. */

export type BBox = [x: number, y: number, width: number, height: number];

export type Direction = "left" | "center" | "right";
export type Distance = "near" | "mid" | "far";
export type Urgency = 0 | 1 | 2 | 3;

export type Tier1HazardType =
  | "chair"
  | "table"
  | "bench"
  | "pole"
  | "vehicle"
  | "bicycle"
  | "person"
  | "animal"
  | "plant"
  | "bag"
  | "other";

export interface RawDetection {
  bbox: BBox;
  class: string;
  score: number;
}

export interface TrackPoint {
  area: number;
  timestamp: number; // in seconds
  cx: number;
  cy: number;
}

export interface TrackedObject {
  id: number;
  class: string;
  hazardType: Tier1HazardType;
  bbox: BBox;
  history: TrackPoint[];
  consecutiveFrames: number;
  lastSeenTimestamp: number;
  lastAnnouncedDistance?: Distance;
  lastAnnouncedAt?: number;
  hasBeenAnnounced?: boolean;
  lastDecision?: string;
}

export interface Tier1Alert {
  type: Tier1HazardType;
  direction: Direction;
  distance: Distance;
  urgency: 2 | 3;
  clear_side: "left" | "right" | "none";
  label?: string;
  closingSpeedPerSec: number;
  timestamp: number;
  confidence: number;
  phrase?: string;
  h_frac: number;
  framesTracked: number;
  ruleFired: string;
  reason: string;
  trackedId?: number;
}

export interface Tier1Metrics {
  fps: number;
  latencyMs: number;
  backend: string;
  loadTimeMs: number;
  status: "idle" | "loading" | "ready" | "error";
  errorMessage?: string;
  alertsPerMin?: number;
}

export interface FrameLuminanceStats {
  mean: number;
  variance: number;
  isBlocked: boolean;
}

export interface BenchmarkResult {
  backend: string;
  inputSize: 192 | 256 | 320;
  numFrames: number;
  medianMs: number;
  p95Ms: number;
  fps: number;
  totalElapsedMs: number;
  error?: string;
}

export type DecisionLabel =
  | "True alert"
  | "False alert"
  | "Correct silence"
  | "Should have alerted"
  | "True"
  | "False"
  | "Missed"
  | "missed"
  | "";

export interface TrackDecisionLog {
  id: string;
  clip: string;
  t: number;
  sample_time?: number;
  class: string;
  direction: Direction;
  decision: "alerted" | `suppressed: ${string}` | "missed_hazard";
  reason: string;
  label?: DecisionLabel;
  trackId: number;
}

export interface Tier1Config {
  nearThreshold: number; // fraction of frame height, default 0.50
  midThreshold: number; // fraction of frame height, default 0.25
  closingThresholdPerSec: number; // area fraction per sec, default 0.05
  fastClosingThresholdPerSec: number; // area fraction per sec, default 0.15
  minScore: number; // min detection confidence, default 0.5
  maxDetections: number; // max detections returned, default 10
  targetFps: number; // target FPS, default 10
  minFps: number; // min FPS before dropping, default 5
  iouMatchThreshold: number; // IoU threshold for tracking, default 0.20
  centroidDistanceThreshold: number; // normalized centroid distance, default 0.25
  reannounceTimeoutMs: number; // 10000 ms
  minConsecutiveFrames: number; // 2 frames debounce for static
  movingMinFrames: number; // 4 frames debounce for moving objects
  minTrackDurationSec?: number; // tracked at least 0.8 s (time-based)
  minClosingDurationSec?: number; // closing sustained at least 0.6 s (time-based)
  staticMinTrackDurationSec?: number; // tracked at least 0.4 s for static obstacles
  perClassClosingThreshold: Record<string, number>;
  globalRateLimitMs: number; // 3000 ms global rate limit unless urgency 3
  inputSize?: 192 | 256 | 320; // default 320, 256 or 192 for slower phones
}
