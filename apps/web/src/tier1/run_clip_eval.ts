/**
 * Deterministic offline clip evaluation runner for Drishti Tier 1.
 *
 * Runs the exact same COCO-SSD model, tracker (updateTracker with gap tolerance),
 * hazard evaluator (evaluateHazardDetails), and arbiter as the live app.
 *
 * Usage:
 *   cd apps/web && npx vite-node src/tier1/run_clip_eval.ts --clip clip_001
 *   cd apps/web && npx vite-node src/tier1/run_clip_eval.ts --clip clip_006
 */

import fs from "node:fs";
import path from "node:path";
import * as tf from "@tensorflow/tfjs";
import * as cocoSsd from "@tensorflow-models/coco-ssd";

import { DEFAULT_TIER1_CONFIG } from "./config";
import { updateTracker } from "./math";
import {
  SampleSpacingStats,
  calculateDecisionSummary,
  computeSampleSpacingStats,
  formatDecisionsToCsv,
} from "./eval_stepper";
import {
  RawDetection,
  TrackDecisionLog,
  TrackedObject,
} from "./types";
import { PriorityArbiter, makeHazardMessage } from "../arbiter";
import { buildPhrase } from "../phrases";

interface FrameManifestItem {
  index: number;
  sample_time: number;
  frame_idx: number;
  filename: string;
  width: number;
  height: number;
  bytes_len: number;
}

interface ClipManifest {
  clip: string;
  duration: number;
  fps: number;
  step_sec: number;
  total_frames: number;
  frames: FrameManifestItem[];
}

async function loadOfflineModel(repoRoot: string): Promise<cocoSsd.ObjectDetection> {
  await tf.setBackend("cpu");
  await tf.ready();

  const modelDir = path.join(repoRoot, "apps", "web", "public", "models", "coco-ssd");
  const modelJson = JSON.parse(fs.readFileSync(path.join(modelDir, "model.json"), "utf8"));

  const buffers: Buffer[] = [];
  for (const group of modelJson.weightsManifest) {
    for (const p of group.paths) {
      buffers.push(fs.readFileSync(path.join(modelDir, p)));
    }
  }
  const weightData = Buffer.concat(buffers).buffer;

  const customIO = {
    load: async () => ({
      modelTopology: modelJson.modelTopology,
      weightSpecs: modelJson.weightsManifest[0].weights,
      weightData: weightData,
      format: modelJson.format,
      generatedBy: modelJson.generatedBy,
      convertedBy: modelJson.convertedBy,
    }),
  };

  return await cocoSsd.load({
    base: "lite_mobilenet_v2",
    modelUrl: customIO as unknown as string,
  });
}

export async function runClipEval(clipName: string) {
  const repoRoot = path.resolve(process.cwd(), "../..");
  const framesDir = path.join(repoRoot, "eval", "frames", clipName);
  const manifestPath = path.join(framesDir, "manifest.json");

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Manifest not found at ${manifestPath}. Run scripts/extract_frames.py first.`);
  }

  const manifest: ClipManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  console.log(`\n======================================================`);
  console.log(`Evaluating ${manifest.clip} (${manifest.duration.toFixed(2)}s, ${manifest.total_frames} frames)`);
  console.log(`======================================================`);

  // 1. Measure and verify sample spacing (Requirement 1)
  const spacings: number[] = [];
  for (let i = 1; i < manifest.frames.length; i++) {
    const fCur = manifest.frames[i]!;
    const fPrev = manifest.frames[i - 1]!;
    const dt = fCur.sample_time - fPrev.sample_time;
    spacings.push(Math.round(dt * 100) / 100);
  }
  const spacingStats: SampleSpacingStats = computeSampleSpacingStats(spacings);
  console.log(`Sample Spacing: min=${spacingStats.min.toFixed(2)}s | median=${spacingStats.median.toFixed(2)}s | max=${spacingStats.max.toFixed(2)}s | count=${spacingStats.count}`);
  if (spacingStats.warning) {
    console.warn(`WARNING: Sample spacing median ${spacingStats.median.toFixed(2)}s > 0.6s!`);
  }

  // 2. Load model
  console.log("Loading offline COCO-SSD model (lite_mobilenet_v2)...");
  const model = await loadOfflineModel(repoRoot);
  console.log("Model loaded successfully.");

  const config = { ...DEFAULT_TIER1_CONFIG };
  let activeTracks: TrackedObject[] = [];
  const allDecisions: TrackDecisionLog[] = [];
  const arbiterAlerts: { time: number; text: string }[] = [];
  let lastSpokenHazardAt = 0;

  const arbiter = new PriorityArbiter(
    (text: string) => {
      arbiterAlerts.push({ time: performance.now(), text });
    },
    () => {},
    { hazardMinIntervalMs: 1500, hazardDedupeMs: 4000 }
  );

  console.log("Running deterministic detection and tracking across frames...");
  for (const item of manifest.frames) {
    const binPath = path.join(framesDir, item.filename);
    const buf = fs.readFileSync(binPath);
    const intArr = new Int32Array(buf.length);
    for (let i = 0; i < buf.length; i++) {
      intArr[i] = buf[i] ?? 0;
    }

    const tensor = tf.tensor3d(intArr, [item.height, item.width, 3], "int32");
    const rawDets = await model.detect(tensor, 10, config.minScore);
    tensor.dispose();

    const mappedDetections: RawDetection[] = rawDets.map((d) => ({
      bbox: d.bbox as [number, number, number, number],
      class: d.class.toLowerCase(),
      score: d.score,
    }));

    // Update tracker with gap-tolerant math
    const { updatedTracks, alerts, decisions } = updateTracker(
      activeTracks,
      mappedDetections,
      item.sample_time,
      item.width,
      item.height,
      config,
      manifest.clip
    );
    activeTracks = updatedTracks;

    // Process alerts through rate limiting and arbiter
    const nowMs = item.sample_time * 1000;
    for (const alert of alerts) {
      if (alert.urgency < 3 && nowMs - lastSpokenHazardAt < config.globalRateLimitMs) {
        const d = decisions.find(
          (elem) => elem.trackId === alert.trackedId && elem.decision === "alerted"
        );
        if (d) {
          d.decision = "suppressed: rate_limited";
          d.reason = `suppressed by 3s global rate limit (${((nowMs - lastSpokenHazardAt) / 1000).toFixed(1)}s < 3s)`;
        }
        continue;
      }
      lastSpokenHazardAt = nowMs;

      const phrase = buildPhrase(
        {
          type: alert.type,
          direction: alert.direction,
          clear_side: alert.clear_side,
          label: alert.label,
        },
        "en"
      );
      if (phrase) {
        arbiter.enqueue(
          makeHazardMessage(
            alert.type,
            alert.direction,
            phrase,
            "en",
            alert.urgency,
            alert.confidence,
            nowMs,
            alert.clear_side
          )
        );
      }
    }

    // Accumulate unique decisions
    for (const d of decisions) {
      allDecisions.push(d);
    }
  }

  // Never create, infer or auto-assign labels. Unlabeled rows remain unlabeled ("")
  // and are strictly excluded from TN, FP and precision calculations.
  // Ground truth labels come exclusively from user-exported CSVs.

  // Compute summary metrics (Requirement 4)
  const summary = calculateDecisionSummary(allDecisions, manifest.duration);

  // Check user labeled misses from user CSV if available
  const userCsvs = [
    path.join(repoRoot, "eval", `${manifest.clip.replace(".mp4", "")}_mp4_tier1_decisions.csv`),
    path.join(repoRoot, "eval", `${manifest.clip.replace(".mp4", "")}_mp4_tier1_decisions_1793559223689.csv`),
  ];
  const userMisses: { t: number; class: string; direction: string }[] = [];
  for (const p of userCsvs) {
    if (fs.existsSync(p)) {
      const lines = fs.readFileSync(p, "utf8").split(/\r?\n/).slice(1);
      for (const line of lines) {
        if (!line.trim()) continue;
        const parts = line.split(",");
        const tVal = parseFloat(parts[3] ?? parts[2] ?? "0");
        const cls = (parts[4] ?? "").replace(/"/g, "").trim();
        const dir = (parts[5] ?? "").replace(/"/g, "").trim();
        const dec = (parts[6] ?? "").replace(/"/g, "").trim();
        if (dec === "missed_hazard") {
          userMisses.push({ t: tVal, class: cls, direction: dir });
        }
      }
    }
  }

  const alertedRows = allDecisions.filter((d) => d.decision === "alerted");

  console.log(`\n--- Results for ${manifest.clip} ---`);
  console.log(`Duration: ${manifest.duration.toFixed(2)}s`);
  console.log(`Total Decisions Logged: ${summary.totalDecisions}`);
  console.log(`Total Alerts: ${summary.totalAlerts} (${summary.alertsPerMin} alerts/min)`);
  console.log(`True Alerts (TP): ${summary.trueAlerts}`);
  console.log(`False Alerts (FP): ${summary.falseAlerts}`);
  console.log(`Correct Silences (TN): ${summary.correctSilences}`);
  console.log(`Missed Hazards (FN): ${summary.missedHazards}`);
  console.log(`Precision: ${summary.precisionPercent} (${summary.precision.toFixed(3)})`);
  console.log(`Recall: ${summary.recallPercent} (${summary.recall.toFixed(3)})`);

  console.log(`\nAlerts Fired (${alertedRows.length}):`);
  if (alertedRows.length === 0) {
    console.log("  (None)");
  } else {
    for (const a of alertedRows) {
      console.log(`  t=${(a.sample_time ?? a.t).toFixed(2)}s | class=${a.class} | dir=${a.direction} | ${a.reason}`);
    }
  }

  if (userMisses.length > 0) {
    console.log(`\nUser Labeled Misses Status (${userMisses.length} misses):`);
    for (const m of userMisses) {
      const hit = alertedRows.find(
        (a) =>
          a.class === m.class &&
          a.direction === m.direction &&
          Math.abs((a.sample_time ?? a.t) - m.t) <= 1.5
      );
      if (hit) {
        console.log(`  ✓ CAUGHT: ${m.class} on ${m.direction} at t=${m.t.toFixed(2)}s (Alert at t=${(hit.sample_time ?? hit.t).toFixed(2)}s)`);
      } else {
        console.log(`  ✗ STILL MISSED: ${m.class} on ${m.direction} at t=${m.t.toFixed(2)}s`);
      }
    }
  }

  console.log(`\nNew Alerts to Judge by User:`);
  if (alertedRows.length === 0) {
    console.log("  (None)");
  } else {
    for (const a of alertedRows) {
      console.log(`  [UNLABELED] t=${(a.sample_time ?? a.t).toFixed(2)}s | ${a.class} | ${a.direction} | ${a.reason}`);
    }
  }

  // Export CSV
  const csvContent = formatDecisionsToCsv(allDecisions);
  const outCsvPath = path.join(repoRoot, "eval", `${manifest.clip.replace(".mp4", "")}_decisions.csv`);
  fs.writeFileSync(outCsvPath, csvContent, "utf8");
  console.log(`Exported decisions CSV to: ${outCsvPath} (${allDecisions.length} rows)`);

  return {
    clip: manifest.clip,
    duration: manifest.duration,
    spacingStats,
    summary,
    csvPath: outCsvPath,
    decisionsCount: allDecisions.length,
  };
}

// CLI entry point
const clipArg = process.argv.find((_a, i) => process.argv[i - 1] === "--clip") || "clip_001";
runClipEval(clipArg).catch((err) => {
  console.error("Evaluation error:", err);
  process.exit(1);
});
