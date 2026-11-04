/** Web Worker running COCO-SSD model with local offline weights. */

import * as tf from "@tensorflow/tfjs";
import { setWasmPaths } from "@tensorflow/tfjs-backend-wasm";
import * as cocoSsd from "@tensorflow-models/coco-ssd";
import { RawDetection } from "./types";

let model: cocoSsd.ObjectDetection | null = null;
let activeBackend = "cpu";
let modelLoadTimeMs = 0;
let isInitializing = false;

interface InitMessage {
  type: "init";
  modelUrl?: string;
  minScore?: number;
  maxDetections?: number;
}

interface DetectMessage {
  type: "detect";
  bitmap: ImageBitmap;
  timestamp: number; // in seconds
  width: number;
  height: number;
  minScore?: number;
  maxDetections?: number;
}

interface SwitchBackendMessage {
  type: "switch_backend";
  backend: "webgl" | "wasm" | "cpu";
}

interface BenchmarkMessage {
  type: "benchmark";
  backend: "webgl" | "wasm" | "cpu";
  inputSize: 192 | 256 | 320;
  numFrames: number;
}

async function setBackendSafely(backendName: "webgl" | "wasm" | "cpu"): Promise<boolean> {
  try {
    if (backendName === "wasm") {
      setWasmPaths("/wasm/");
    }
    const success = await tf.setBackend(backendName);
    if (success) {
      await tf.ready();
      activeBackend = tf.getBackend();
      return true;
    }
    return false;
  } catch (err) {
    console.warn(`[Worker] Failed to set backend ${backendName}:`, err);
    return false;
  }
}

async function initializeModel(modelUrl = "/models/coco-ssd/model.json") {
  if (model) return;
  if (isInitializing) return;
  isInitializing = true;

  const tStart = performance.now();

  // Try WebGL first -> WASM SIMD -> CPU fallback
  const webglOk = await setBackendSafely("webgl");
  if (!webglOk) {
    const wasmOk = await setBackendSafely("wasm");
    if (!wasmOk) {
      await setBackendSafely("cpu");
    }
  }

  try {
    // Load local offline COCO-SSD model with lite_mobilenet_v2
    model = await cocoSsd.load({
      base: "lite_mobilenet_v2",
      modelUrl,
    });

    // Warm up model at load with a dummy tensor
    try {
      const dummy = tf.zeros([180, 320, 3], "int32") as tf.Tensor3D;
      await model.detect(dummy, 1, 0.5);
      dummy.dispose();
    } catch (warmupErr) {
      console.warn("[Worker] Model warmup warning:", warmupErr);
    }

    modelLoadTimeMs = Math.round(performance.now() - tStart);

    self.postMessage({
      type: "ready",
      backend: activeBackend,
      loadTimeMs: modelLoadTimeMs,
    });
  } catch (loadErr) {
    const errMsg = String(loadErr);
    const url = "/models/coco-ssd/model.json";
    let status: number | undefined;
    const message = errMsg;

    // Try to extract URL and HTTP status from the error
    if (errMsg.includes("404") || errMsg.includes("Not Found")) {
      status = 404;
    } else if (errMsg.includes("403") || errMsg.includes("Forbidden")) {
      status = 403;
    } else if (errMsg.includes("500") || errMsg.includes("Internal Server")) {
      status = 500;
    } else if (errMsg.includes("503") || errMsg.includes("Service Unavailable")) {
      status = 503;
    } else if (errMsg.includes("fetch") || errMsg.includes("network") || errMsg.includes("NetworkError")) {
      status = 0; // Network error
    }

    self.postMessage({
      type: "error",
      error: `Model load failed: ${errMsg}`,
      url,
      status,
      message,
    });
  } finally {
    isInitializing = false;
  }
}

self.onmessage = async (
  e: MessageEvent<InitMessage | DetectMessage | SwitchBackendMessage | BenchmarkMessage>
) => {
  const data = e.data;

  if (data.type === "init") {
    await initializeModel(data.modelUrl);
    return;
  }

  if (data.type === "switch_backend") {
    const ok = await setBackendSafely(data.backend);
    self.postMessage({
      type: "backend_switched",
      backend: activeBackend,
      success: ok,
    });
    return;
  }

  if (data.type === "benchmark") {
    const { backend, inputSize = 320, numFrames = 100 } = data;

    // Switch to requested runtime
    const switchOk = await setBackendSafely(backend);
    if (!switchOk) {
      self.postMessage({
        type: "benchmark_result",
        error: `Could not initialize ${backend} backend on this device`,
        backend,
        inputSize,
        numFrames: 0,
        medianMs: 0,
        p95Ms: 0,
        fps: 0,
        totalElapsedMs: 0,
      });
      return;
    }

    if (!model) {
      self.postMessage({
        type: "benchmark_result",
        error: "Model not loaded",
        backend,
        inputSize,
        numFrames: 0,
        medianMs: 0,
        p95Ms: 0,
        fps: 0,
        totalElapsedMs: 0,
      });
      return;
    }

    const dummyH = Math.round(inputSize * (9 / 16));
    // Warmup 2 frames
    try {
      const warmTensor = tf.zeros([dummyH, inputSize, 3], "int32") as tf.Tensor3D;
      await model.detect(warmTensor, 10, 0.5);
      await model.detect(warmTensor, 10, 0.5);
      warmTensor.dispose();
    } catch {
      // ignore warmup error
    }

    const latencies: number[] = [];
    const tBenchStart = performance.now();

    for (let i = 0; i < numFrames; i++) {
      const dummy = tf.zeros([dummyH, inputSize, 3], "int32") as tf.Tensor3D;
      const t0 = performance.now();
      await model.detect(dummy, 10, 0.5);
      const t1 = performance.now();
      dummy.dispose();
      latencies.push(t1 - t0);
    }

    const totalElapsed = performance.now() - tBenchStart;
    latencies.sort((a, b) => a - b);
    const medianMs = Math.round((latencies[Math.floor(latencies.length * 0.5)] ?? 0) * 10) / 10;
    const p95Ms = Math.round((latencies[Math.floor(latencies.length * 0.95)] ?? 0) * 10) / 10;
    const fps = totalElapsed > 0 ? Math.round((numFrames / (totalElapsed / 1000)) * 10) / 10 : 0;

    self.postMessage({
      type: "benchmark_result",
      backend: tf.getBackend(),
      inputSize,
      numFrames,
      medianMs,
      p95Ms,
      fps,
      totalElapsedMs: Math.round(totalElapsed),
    });
    return;
  }

  if (data.type === "detect") {
    const { bitmap, timestamp, width, height, minScore = 0.5, maxDetections = 10 } = data;
    const frameStart = performance.now();

    if (!model) {
      bitmap.close();
      self.postMessage({
        type: "error",
        error: "Model not loaded",
      });
      return;
    }

    try {
      // Scale factors to map downscaled bitmap predictions back to original dimensions
      const bitmapW = bitmap.width;
      const bitmapH = bitmap.height;
      const scaleX = width > 0 && bitmapW > 0 ? width / bitmapW : 1.0;
      const scaleY = height > 0 && bitmapH > 0 ? height / bitmapH : 1.0;

      // Convert ImageBitmap to tf.Tensor3D for model.detect
      const tensor = tf.browser.fromPixels(bitmap);
      const rawPreds = await model.detect(tensor, maxDetections, minScore);

      // Dispose tensors and close bitmap immediately
      tensor.dispose();
      bitmap.close();

      const latencyMs = Math.round(performance.now() - frameStart);
      const detections: RawDetection[] = rawPreds.map((p) => ({
        bbox: [
          p.bbox[0] * scaleX,
          p.bbox[1] * scaleY,
          p.bbox[2] * scaleX,
          p.bbox[3] * scaleY,
        ] as [number, number, number, number],
        class: p.class.toLowerCase(),
        score: p.score,
      }));

      self.postMessage({
        type: "detections",
        detections,
        timestamp,
        latencyMs,
        backend: activeBackend,
        loadTimeMs: modelLoadTimeMs,
      });
    } catch (detectErr) {
      bitmap.close();
      self.postMessage({
        type: "error",
        error: `Detection error: ${String(detectErr)}`,
      });
    }
  }
};
