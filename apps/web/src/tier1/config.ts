import { Tier1Config, Tier1HazardType } from "./types";

export const COCO_TO_HAZARD_MAP: Record<string, Tier1HazardType> = {
  person: "person",
  bicycle: "bicycle",
  car: "vehicle",
  motorcycle: "vehicle",
  bus: "vehicle",
  truck: "vehicle",
  dog: "animal",
  cow: "animal",
  horse: "animal",
  sheep: "animal",
  cat: "animal",
  chair: "chair",
  couch: "chair",
  bench: "bench",
  "dining table": "table",
  "fire hydrant": "pole",
  "potted plant": "plant",
  suitcase: "bag",
};

export const MOVING_CLASSES = new Set<Tier1HazardType>([
  "person",
  "bicycle",
  "vehicle",
  "animal",
]);

export const DEFAULT_TIER1_CONFIG: Tier1Config = {
  nearThreshold: 0.50,
  midThreshold: 0.25,
  closingThresholdPerSec: 0.05,
  fastClosingThresholdPerSec: 0.15,
  minScore: 0.5,
  maxDetections: 10,
  targetFps: 10,
  minFps: 5,
  iouMatchThreshold: 0.20,
  centroidDistanceThreshold: 0.25,
  reannounceTimeoutMs: 10000,
  minConsecutiveFrames: 2,
  movingMinFrames: 4,
  minTrackDurationSec: 0.8,
  minClosingDurationSec: 0.6,
  staticMinTrackDurationSec: 0.4,
  perClassClosingThreshold: {
    person: 0.08,
    bicycle: 0.06,
    vehicle: 0.05,
    animal: 0.06,
    default: 0.05,
  },
  globalRateLimitMs: 3000,
  inputSize: 320,
};
