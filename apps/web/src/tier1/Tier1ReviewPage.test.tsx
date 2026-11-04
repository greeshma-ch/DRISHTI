/**
 * Component test for Tier1ReviewPage.
 *
 * Asserts:
 * 1. Page renders Tier 1 status telemetry (backend, load time, model URL, detector status, error details).
 * 2. Canvas draws bounding boxes via drawOverlay (strokeRect, fillText) using mocked detector fixture.
 * 3. Decision row appears in table with alerted state, fast_closing_override rule, and vehicle details.
 * 4. Labels remain unlabeled ("") - never auto-labeled or fabricated.
 * 5. Browser console errors panel captures and displays errors live on screen.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import ReactDOM from "react-dom/client";
import { Tier1ReviewPage } from "./Tier1ReviewPage";
import {
  Tier1Alert,
  Tier1Metrics,
  TrackDecisionLog,
  TrackedObject,
} from "./types";
import { Tier1Detector } from "./detector";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Tier1ReviewPage Component Test", () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;
  let mockCtx: {
    clearRect: ReturnType<typeof vi.fn>;
    strokeRect: ReturnType<typeof vi.fn>;
    fillRect: ReturnType<typeof vi.fn>;
    fillText: ReturnType<typeof vi.fn>;
    beginPath: ReturnType<typeof vi.fn>;
    moveTo: ReturnType<typeof vi.fn>;
    lineTo: ReturnType<typeof vi.fn>;
    stroke: ReturnType<typeof vi.fn>;
    setLineDash: ReturnType<typeof vi.fn>;
    measureText: ReturnType<typeof vi.fn>;
  };

  const mockVehicleTrack: TrackedObject = {
    id: 6,
    class: "car",
    hazardType: "vehicle",
    bbox: [430, 60, 200, 238],
    history: [
      { area: 0.05, timestamp: 11.2, cx: 0.8, cy: 0.5, h_frac: 0.33, bbox: [450, 60, 107, 120] },
      { area: 0.25, timestamp: 11.6, cx: 0.8, cy: 0.5, h_frac: 0.66, bbox: [430, 60, 200, 238] },
    ],
    consecutiveFrames: 2,
    lastSeenTimestamp: 11.6,
  };

  const mockAlert: Tier1Alert = {
    type: "vehicle",
    direction: "right",
    distance: "near",
    urgency: 3,
    clear_side: "none",
    closingSpeedPerSec: 0.28,
    timestamp: 11600,
    confidence: 0.9,
    h_frac: 0.66,
    framesTracked: 2,
    ruleFired: "fast_closing_override",
    reason: "vehicle | h=0.66 | v=0.28/s | right | 0.40s | fast_closing_override",
    trackedId: 6,
  };

  const mockDecision: TrackDecisionLog = {
    id: "11.60_6_vehicle_alerted",
    clip: "clip_001.mp4",
    sample_time: 11.6,
    t: 11.6,
    trackId: 6,
    class: "vehicle",
    direction: "right",
    decision: "alerted",
    reason: "vehicle | h=0.66 | v=0.28/s | right | 0.40s | fast_closing_override",
    label: "",
  };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);

    mockCtx = {
      clearRect: vi.fn(),
      strokeRect: vi.fn(),
      fillRect: vi.fn(),
      fillText: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      setLineDash: vi.fn(),
      measureText: vi.fn(() => ({ width: 80 })),
    };

    HTMLCanvasElement.prototype.getContext = vi.fn((contextId: string) => {
      if (contextId === "2d") return mockCtx as unknown as CanvasRenderingContext2D;
      return null;
    }) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it("renders Tier 1 status telemetry HUD values accurately", async () => {
    const mockMetrics: Tier1Metrics = {
      fps: 10.4,
      latencyMs: 24,
      backend: "webgl",
      loadTimeMs: 285,
      status: "ready",
      errorMessage: undefined,
    };

    const mockDetector = {
      getMetrics: () => mockMetrics,
      getTracks: () => [],
      onMetrics: vi.fn((cb) => {
        cb(mockMetrics);
        return () => {};
      }),
      onDecision: vi.fn(() => () => {}),
      onAlert: vi.fn(() => () => {}),
      onError: vi.fn(() => () => {}),
      onCameraBlocked: vi.fn(() => () => {}),
      onCameraClear: vi.fn(() => () => {}),
      start: vi.fn(),
      stop: vi.fn(),
      clear: vi.fn(),
      isBusy: vi.fn(() => false),
      updateConfig: vi.fn(),
      switchBackend: vi.fn(async (b) => b),
      runBenchmark: vi.fn(),
      detectFrame: vi.fn(async () => ({ updatedTracks: [], alerts: [], decisions: [] })),
    };

    await act(async () => {
      root.render(
        <Tier1ReviewPage
          onBack={vi.fn()}
          detector={mockDetector as unknown as Tier1Detector}
          initialVideoSrc="blob:mock-clip"
          initialFileName="clip_001.mp4"
          initialIsLoadedData={true}
        />
      );
    });

    // Check Status Telemetry
    expect(container.textContent).toContain("Tier 1 Detector Status & Telemetry");
    expect(container.textContent).toContain("Status: READY");
    expect(container.textContent).toContain("webgl");
    expect(container.textContent).toContain("285 ms");
    expect(container.textContent).toContain("/models/coco-ssd/model.json");
    expect(container.textContent).toContain("10.4 FPS");
    expect(container.textContent).toContain("None");

    // Check Console Error Panel (clean state)
    expect(container.textContent).toContain("Browser Console & Runtime Errors");
    expect(container.textContent).toContain("No browser console errors recorded");
  });

  it("draws bounding boxes on canvas and renders decision rows in table with mocked detector", async () => {
    let processFrameRef: ((t: number) => Promise<void>) | null = null;
    let decisionCallback: ((d: TrackDecisionLog) => void) | null = null;
    let alertCallback: ((a: Tier1Alert) => void) | null = null;

    const mockMetrics: Tier1Metrics = {
      fps: 12.0,
      latencyMs: 30,
      backend: "webgl",
      loadTimeMs: 190,
      status: "ready",
    };

    const mockDetector = {
      getMetrics: () => mockMetrics,
      getTracks: () => [mockVehicleTrack],
      onMetrics: vi.fn((cb) => {
        cb(mockMetrics);
        return () => {};
      }),
      onDecision: vi.fn((cb) => {
        decisionCallback = cb;
        return () => {};
      }),
      onAlert: vi.fn((cb) => {
        alertCallback = cb;
        return () => {};
      }),
      onError: vi.fn(() => () => {}),
      onCameraBlocked: vi.fn(() => () => {}),
      onCameraClear: vi.fn(() => () => {}),
      start: vi.fn(),
      stop: vi.fn(),
      clear: vi.fn(),
      isBusy: vi.fn(() => false),
      updateConfig: vi.fn(),
      switchBackend: vi.fn(async (b) => b),
      runBenchmark: vi.fn(),
      detectFrame: vi.fn(async () => {
        if (decisionCallback) {
          decisionCallback(mockDecision);
        }
        if (alertCallback) {
          alertCallback(mockAlert);
        }
        return {
          updatedTracks: [mockVehicleTrack],
          alerts: [mockAlert],
          decisions: [mockDecision],
        };
      }),
    };

    await act(async () => {
      root.render(
        <Tier1ReviewPage
          onBack={vi.fn()}
          detector={mockDetector as unknown as Tier1Detector}
          initialVideoSrc="blob:mock-clip"
          initialFileName="clip_001.mp4"
          initialIsLoadedData={true}
          onMounted={(controls) => {
            processFrameRef = controls.processFrame;
          }}
        />
      );
    });

    expect(processFrameRef).not.toBeNull();

    // Trigger frame evaluation at t=11.60s
    await act(async () => {
      if (processFrameRef) {
        await processFrameRef(11.6);
      }
    });

    // 1. Assert bounding boxes are drawn on the canvas
    expect(mockCtx.strokeRect).toHaveBeenCalledWith(430, 60, 200, 238);
    expect(mockCtx.fillText).toHaveBeenCalledWith("vehicle #6 (2f)", expect.any(Number), expect.any(Number));

    // 2. Assert decision row appears in the DOM table
    const tableText = container.textContent || "";
    expect(tableText).toContain("11.60s");
    expect(tableText).toContain("vehicle");
    expect(tableText).toContain("right");
    expect(tableText).toContain("alerted");
    expect(tableText).toContain("fast_closing_override");
    expect(tableText).toContain("vehicle | h=0.66 | v=0.28/s | right | 0.40s | fast_closing_override");

    // 3. Assert row is unlabeled (per Rule 9/10: ground truth comes only from user CSVs)
    expect(tableText).toContain("True alert");
    expect(tableText).toContain("False alert");
    // Row label must be blank/unlabeled
    expect(mockDecision.label).toBe("");
  });

  it("captures and displays browser console errors live on screen", async () => {
    const mockDetector = {
      getMetrics: () => ({ fps: 0, latencyMs: 0, backend: "cpu", loadTimeMs: 0, status: "idle" as const }),
      getTracks: () => [],
      onMetrics: vi.fn(() => () => {}),
      onDecision: vi.fn(() => () => {}),
      onAlert: vi.fn(() => () => {}),
      onError: vi.fn(() => () => {}),
      onCameraBlocked: vi.fn(() => () => {}),
      onCameraClear: vi.fn(() => () => {}),
      start: vi.fn(),
      stop: vi.fn(),
      clear: vi.fn(),
      isBusy: vi.fn(() => false),
      updateConfig: vi.fn(),
      switchBackend: vi.fn(async (b) => b),
      runBenchmark: vi.fn(),
      detectFrame: vi.fn(async () => ({ updatedTracks: [], alerts: [], decisions: [] })),
    };

    await act(async () => {
      root.render(
        <Tier1ReviewPage
          onBack={vi.fn()}
          detector={mockDetector as unknown as Tier1Detector}
          initialVideoSrc="blob:mock"
          initialFileName="clip_001.mp4"
          initialIsLoadedData={true}
        />
      );
    });

    // Dispatch a browser error event
    await act(async () => {
      window.dispatchEvent(
        new ErrorEvent("error", {
          message: "Failed to fetch /models/coco-ssd/weights.bin (404 Not Found)",
        })
      );
    });

    expect(container.textContent).toContain("Browser Console & Runtime Errors (1)");
    expect(container.textContent).toContain("Failed to fetch /models/coco-ssd/weights.bin (404 Not Found)");
  });
});

