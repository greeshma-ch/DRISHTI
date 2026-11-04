/**
 * Diagnostic inspector for clip_001 between t=10.0s and t=14.0s.
 *
 * Prints per-sample table:
 * sample_time, class, bbox, direction, h_frac, area, growth per second, seconds tracked, decision and rule.
 */

import fs from "node:fs";
import path from "node:path";
import * as tf from "@tensorflow/tfjs";
import * as cocoSsd from "@tensorflow-models/coco-ssd";

import { DEFAULT_TIER1_CONFIG } from "./config";
import {
  computeClosingSpeedPerSec,
  evaluateHazardDetails,
  getTrackedDurationSec,
  updateTracker,
} from "./math";
import { RawDetection, TrackedObject } from "./types";

function getRepoRoot(): string {
  let cur = process.cwd();
  while (!fs.existsSync(path.join(cur, "eval", "frames")) && path.dirname(cur) !== cur) {
    cur = path.dirname(cur);
  }
  return cur;
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

async function inspectWindow() {
  const repoRoot = getRepoRoot();
  const framesDir = path.join(repoRoot, "eval", "frames", "clip_001");
  const manifestPath = path.join(framesDir, "manifest.json");

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const model = await loadOfflineModel(repoRoot);

  const config = { ...DEFAULT_TIER1_CONFIG };
  let activeTracks: TrackedObject[] = [];

  console.log("=".repeat(140));
  console.log("clip_001 Sample Inspection from t=0.0s to 2.0s");
  console.log("=".repeat(140));
  console.log(
    `${"Time(s)".padEnd(8)} ${"Track".padEnd(7)} ${"Class".padEnd(9)} ${"BBox [x,y,w,h]".padEnd(24)} ` +
    `${"h_frac".padEnd(8)} ${"Δh_frac".padEnd(9)} ${"Growth/s".padEnd(10)} ` +
    `${"Frames".padEnd(8)} ${"Tracked(s)".padEnd(11)} ${"Decision".padEnd(14)} ${"Rule".padEnd(24)} ${"Reason"}`
  );
  console.log("-".repeat(140));

  for (const item of manifest.frames) {
    const t = item.sample_time;
    if (t > 2.05) {
      break;
    }

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

    const { updatedTracks } = updateTracker(
      activeTracks,
      mappedDetections,
      t,
      item.width,
      item.height,
      config,
      "clip_001.mp4"
    );
    activeTracks = updatedTracks;

    // Filter to sample window t in [0.0, 2.0]
    if (t <= 2.05) {
      let printed = 0;
      for (const track of activeTracks) {
        const isPresent = track.lastSeenTimestamp === t;
        const evalRes = evaluateHazardDetails(track, item.width, item.height, config);

        const [bx, by, bw, bh] = track.bbox.map((v) => Math.round(v));
        const bboxStr = `[${bx},${by},${bw},${bh}]`;
        const currHFrac = track.bbox[3] / item.height;
        const hFracStr = currHFrac.toFixed(3);

        let deltaHFracStr = "0.000";
        if (track.history.length >= 2) {
          const pCurr = track.history[track.history.length - 1]!;
          const pPrev = track.history[track.history.length - 2]!;
          const prevH = pPrev.h_frac ?? (pPrev.bbox ? pPrev.bbox[3] / item.height : 0);
          const currH = pCurr.h_frac ?? currHFrac;
          const dh = currH - prevH;
          deltaHFracStr = (dh >= 0 ? "+" : "") + dh.toFixed(3);
        } else {
          deltaHFracStr = "N/A(first)";
        }

        const speed = computeClosingSpeedPerSec(track.history, config.minClosingDurationSec ?? 0.6);
        const growthStr = (speed >= 0 ? "+" : "") + speed.toFixed(3) + "/s";
        const dur = getTrackedDurationSec(track.history);
        const trackedSec = dur.toFixed(2) + "s";
        const statusPrefix = isPresent ? "" : "(gap) ";

        console.log(
          `${t.toFixed(2).padEnd(8)} #${String(track.id).padEnd(6)} ${(statusPrefix + track.hazardType).padEnd(9)} ` +
          `${bboxStr.padEnd(24)} ${hFracStr.padEnd(8)} ${deltaHFracStr.padEnd(9)} ` +
          `${growthStr.padEnd(10)} ${String(track.history.length).padEnd(8)} ${trackedSec.padEnd(11)} ` +
          `${evalRes.decision.padEnd(14)} ${evalRes.rule.padEnd(24)} ${evalRes.reason}`
        );
        printed++;
      }
      if (printed === 0) {
        console.log(`${t.toFixed(2).padEnd(8)} (no active tracks)`);
      }
    }
  }
  console.log("=".repeat(140));
}

inspectWindow().catch(console.error);
