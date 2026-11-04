/** Client network failure tests (P4).
 *
 * Tests that network failure / timeout on /frame triggers
 * client-side "Vision limited..." after 2 failures OR 4s.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import ReactDOM from "react-dom/client";
import MainApp from "./App";

// Enable act() support in vitest
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Module-level mock references
let mockFetch: ReturnType<typeof vi.fn>;
let mockSpeak: ReturnType<typeof vi.fn>;
let mockCancel: ReturnType<typeof vi.fn>;
let mockGetVoices: ReturnType<typeof vi.fn>;

const mockOscillator = {
  connect: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  type: "sine",
  frequency: { setValueAtTime: vi.fn() },
};
const mockGainNode = {
  connect: vi.fn(),
  gain: {
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  },
};
const mockAudioContext = {
  createOscillator: vi.fn(() => mockOscillator),
  createGain: vi.fn(() => mockGainNode),
  destination: {},
  currentTime: 0,
  state: "running",
  resume: vi.fn().mockResolvedValue(undefined),
};

class MockSpeechSynthesisUtterance {
  text: string;
  lang = "en-IN";
  volume = 1;
  voice: SpeechSynthesisVoice | null = null;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(text: string) {
    this.text = text;
    // Auto-call onend after a microtask to simulate speech completion
    Promise.resolve().then(() => {
      if (this.onend) this.onend();
    });
  }
}

// Helper to render app and return container
function renderApp() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOM.createRoot(container);
  act(() => {
    root.render(<MainApp />);
  });
  return { container, root };
}

// Helper to click Start Vision button
async function clickStartVision(container: HTMLElement) {
  const startButton = container.querySelector("button");
  if (startButton) {
    await act(async () => {
      startButton.click();
      await Promise.resolve();
    });
    // Flush microtasks from startVision async operations
    await act(async () => {
      await Promise.resolve();
    });
  }
}

// Helper to find spoken messages from mockSpeak
function getSpokenMessages() {
  return mockSpeak.mock.calls.map((call) => {
    const utterance = call[0] as string | MockSpeechSynthesisUtterance;
    return typeof utterance === "string" ? utterance : utterance.text;
  });
}

// Helper to check if a message was spoken
function wasSpoken(text: string) {
  return getSpokenMessages().some((msg) => msg.includes(text));
}

describe("Client Network Failure Handling", () => {
  let container: HTMLElement;
  let root: ReactDOM.Root;

  beforeEach(() => {
    vi.useFakeTimers();

    // Reset all mocks fresh for each test
    // Default fetch response: valid audio manifest (prevents unhandled rejections in audio.ts)
    const createMockResponse = (overrides = {}) =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ version: 1, clips: { hazards: {}, system: {} } }),
        ...overrides,
      });

    mockFetch = vi.fn().mockImplementation(() => createMockResponse());
    global.fetch = mockFetch;

    mockSpeak = vi.fn();
    mockCancel = vi.fn();
    mockGetVoices = vi.fn().mockReturnValue([
      { lang: "en-US", name: "English" },
      { lang: "hi-IN", name: "Hindi" },
    ]);

    Object.defineProperty(window, "SpeechSynthesisUtterance", {
      value: MockSpeechSynthesisUtterance,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, "speechSynthesis", {
      value: {
        speak: mockSpeak,
        cancel: mockCancel,
        getVoices: mockGetVoices,
        speaking: false,
        pending: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
      writable: true,
    });
    Object.defineProperty(window, "AudioContext", {
      value: vi.fn(() => mockAudioContext),
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, "webkitAudioContext", {
      value: vi.fn(() => mockAudioContext),
      writable: true,
      configurable: true,
    });

    // Mock media devices
    const mockGetUserMedia = vi.fn().mockResolvedValue({
      getTracks: () => [{ stop: vi.fn() }],
    });
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: mockGetUserMedia },
      writable: true,
    });

    Object.defineProperty(HTMLMediaElement.prototype, "play", {
      configurable: true,
      value: vi.fn().mockResolvedValue(undefined),
    });
    Object.defineProperty(HTMLMediaElement.prototype, "readyState", {
      configurable: true,
      value: 4,
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
      fillRect: vi.fn(),
    } as never);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) =>
      callback(new Blob(["test"], { type: "image/jpeg" }))
    );

    // Mock Worker to avoid loading real COCO-SSD model
    const mockWorker = {
      postMessage: vi.fn(),
      terminate: vi.fn(),
      onmessage: null,
      onerror: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    // When Worker is constructed, immediately post "ready" message
    let mockWorkerInstance: { onmessage: ((e: MessageEvent) => void) | null; postMessage: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn>; onerror: null; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> };
    vi.stubGlobal("Worker", vi.fn().mockImplementation(() => {
      mockWorkerInstance = { ...mockWorker };
      // Simulate async ready message
      setTimeout(() => {
        mockWorkerInstance.onmessage?.({ data: { type: "ready", backend: "cpu", loadTimeMs: 100 } } as MessageEvent);
      }, 0);
      return mockWorkerInstance;
    }));

    // Clean up previous render
    if (root) {
      act(() => {
        root.unmount();
      });
    }
    if (container) {
      container.remove();
    }

    const rendered = renderApp();
    container = rendered.container;
    root = rendered.root;
  });

  afterEach(() => {
    vi.useRealTimers();
    if (root) {
      act(() => {
        root.unmount();
      });
    }
    if (container) {
      container.remove();
    }
  });

  // Helper to wait for startVision to complete (sets isRunning=true)
  async function waitForVisionRunning() {
    await act(async () => {
      for (let i = 0; i < 20; i++) {
        const statusEl = container.querySelector('[style*="rgba(0,0,0,0.75)"]');
        if (statusEl?.textContent?.includes("Vision running")) {
          break;
        }
        await vi.advanceTimersByTimeAsync(50);
      }
      // Flush microtasks without firing recurring intervals
      await Promise.resolve();
    });
  }

  it("speaks 'Vision limited, moving-object alerts only' after 2 consecutive network failures", async () => {
    await clickStartVision(container);
    await waitForVisionRunning();

    // Mock 2 consecutive network failures for the interval calls (not the warm-up)
    mockFetch.mockRejectedValue(new Error("Network error"));

    // Trigger first frame capture (at ~2000ms)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });

    // First failure - should NOT speak Vision limited yet
    expect(wasSpoken("Vision limited, moving-object alerts only")).toBe(false);

    // Trigger second frame capture (after 2000ms backoff = ~4000ms total)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });

    // Second failure - SHOULD speak Vision limited
    expect(wasSpoken("Vision limited, moving-object alerts only")).toBe(true);

    // Should only speak once per episode
    const visionLimitedCalls = getSpokenMessages().filter((msg) =>
      msg.includes("Vision limited, moving-object alerts only")
    );
    expect(visionLimitedCalls.length).toBe(1);
  });

  it("speaks 'Vision limited, moving-object alerts only' after 4s with no response (backoff >= 4000ms)", async () => {
    await clickStartVision(container);
    await waitForVisionRunning();

    // Mock network failure
    mockFetch.mockRejectedValue(new Error("Network error"));

    // Trigger first frame capture
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });

    // Wait for backoff to reach 4000ms (2nd failure = 4000ms backoff)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });

    expect(wasSpoken("Vision limited, moving-object alerts only")).toBe(true);
  });

  it("speaks 'Vision back' on recovery after network failure", async () => {
    await clickStartVision(container);
    await waitForVisionRunning();

    // Mock 2 network failures
    mockFetch.mockRejectedValue(new Error("Network error"));

    // First capture at ~2000ms -> 1st failure -> backoff 2000ms
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    // Second capture at ~4000ms (2000 + 2000 backoff) -> 2nd failure -> backoff 4000ms
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });

    expect(wasSpoken("Vision limited, moving-object alerts only")).toBe(true);

    // Now mock successful response
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        perception: { hazard: null, hazards: [], path_clear: true, instruction: "", signage_text: [] },
        usage: { input_tokens: 100, output_tokens: 10, est_cost_usd: 0.001, finish_reason: "stop" },
        latency_ms: 100,
        client_timestamp: Date.now() / 1000,
        server_total_ms: 200,
        meta_ms: 150,
        finish_reason: "stop",
        retries_display: "0 / 0",
        median_reasoning_tokens: 0,
      }),
    });

    // Trigger next frame capture (after 4000ms backoff)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4100);
    });

    console.log("=== Network failure recovery test - Spoken messages ===");
    console.log(getSpokenMessages());

    expect(wasSpoken("Vision back")).toBe(true);
  });

  it("does not duplicate Vision limited with server degraded result", async () => {
    await clickStartVision(container);
    await waitForVisionRunning();

    // First: client gets network failure (2 times) -> speaks Vision limited
    mockFetch.mockRejectedValue(new Error("Network error"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });

    expect(wasSpoken("Vision limited, moving-object alerts only")).toBe(true);

    // Now server returns degraded result
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        perception: {
          status: "degraded",
          reason: "circuit_open",
          hazard: null,
          hazards: [],
          path_clear: false,
          instruction: "Vision limited, moving-object alerts only",
          signage_text: []
        },
        usage: { input_tokens: 100, output_tokens: 10, est_cost_usd: 0.001, finish_reason: "stop" },
        latency_ms: 100,
        client_timestamp: Date.now() / 1000,
        server_total_ms: 200,
        meta_ms: 150,
        finish_reason: "stop",
        retries_display: "0 / 0",
        median_reasoning_tokens: 0,
      }),
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });

    // Should NOT speak Vision limited again (already spoken for this episode)
    const visionLimitedCalls = getSpokenMessages().filter((msg) =>
      msg.includes("Vision limited, moving-object alerts only")
    );
    expect(visionLimitedCalls.length).toBe(1);
  });

  it("handles 429 with Retry-After header", async () => {
    await clickStartVision(container);
    await waitForVisionRunning();

    // Mock 429 response
    mockFetch.mockResolvedValue({
      status: 429,
      headers: new Headers({ "Retry-After": "5" }),
      ok: false,
      json: async () => ({}),
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });

    // Should speak Vision limited once
    expect(wasSpoken("Vision limited, moving-object alerts only")).toBe(true);

    // Should schedule retry with Retry-After delay (5 seconds = 5000ms)
    // Next call should happen after 5000ms
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5100);
    });

    // Should attempt again (1 manifest + 2 capture calls)
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("handles suggested_interval_ms from server", async () => {
    await clickStartVision(container);
    await waitForVisionRunning();

    // Mock successful response with suggested_interval_ms
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        perception: { hazard: null, hazards: [], path_clear: true, instruction: "", signage_text: [] },
        usage: {
          input_tokens: 100,
          output_tokens: 10,
          est_cost_usd: 0.001,
          finish_reason: "stop",
          suggested_interval_ms: 4000
        },
        latency_ms: 100,
        client_timestamp: Date.now() / 1000,
        server_total_ms: 200,
        meta_ms: 150,
        finish_reason: "stop",
        retries_display: "0 / 0",
        median_reasoning_tokens: 0,
      }),
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });

    // Next interval should be 4000ms instead of 2000ms
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4100);
    });

    // 1 manifest + 2 capture calls
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("speaks 'Vision back' after first valid result following degraded episode (no 10s debounce, even if Vision limited not spoken)", async () => {
    await clickStartVision(container);
    await waitForVisionRunning();

    // Simulate server returning degraded response (e.g., circuit_open) - this sets isVisionDegradedRef.current = true
    // but we DON'T advance timers enough for Vision limited to be spoken (or it's spoken but we test recovery)
    // First, send a degraded response
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        perception: {
          status: "degraded",
          reason: "circuit_open",
          hazard: null,
          hazards: [],
          path_clear: false,
          instruction: "Vision limited, moving-object alerts only",
          signage_text: []
        },
        usage: { input_tokens: 100, output_tokens: 10, est_cost_usd: 0.001, finish_reason: "stop" },
        latency_ms: 100,
        client_timestamp: Date.now() / 1000,
        server_total_ms: 200,
        meta_ms: 150,
        finish_reason: "stop",
        retries_display: "0 / 0",
        median_reasoning_tokens: 0,
      }),
    });

    // Trigger first frame capture - this should receive degraded and set isVisionDegraded = true
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });

    // Should have spoken "Vision limited" for degraded
    expect(wasSpoken("Vision limited, moving-object alerts only")).toBe(true);

    // Now send a valid non-degraded response (recovery)
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        perception: { hazard: null, hazards: [], path_clear: true, instruction: "", signage_text: [] },
        usage: { input_tokens: 100, output_tokens: 10, est_cost_usd: 0.001, finish_reason: "stop" },
        latency_ms: 100,
        client_timestamp: Date.now() / 1000,
        server_total_ms: 200,
        meta_ms: 150,
        finish_reason: "stop",
        retries_display: "0 / 0",
        median_reasoning_tokens: 0,
      }),
    });

    // Trigger next frame capture - this should be the FIRST valid result after degraded
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });

    // Should speak "Vision back" immediately (no 10s debounce)
    expect(wasSpoken("Vision back")).toBe(true);
  });

  it("speaks 'Vision back' after degraded episode even if arbiter suppressed 'Vision limited'", async () => {
    await clickStartVision(container);
    await waitForVisionRunning();

    // Simulate server returning degraded response - this sets isVisionDegradedRef.current = true
    // and speaks "Vision limited", but we verify Vision back is spoken on recovery regardless
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        perception: {
          status: "degraded",
          reason: "spend_blocked",
          hazard: null,
          hazards: [],
          path_clear: false,
          instruction: "Vision limited, moving-object alerts only",
          signage_text: []
        },
        usage: { input_tokens: 100, output_tokens: 10, est_cost_usd: 0.001, finish_reason: "stop" },
        latency_ms: 100,
        client_timestamp: Date.now() / 1000,
        server_total_ms: 200,
        meta_ms: 150,
        finish_reason: "stop",
        retries_display: "0 / 0",
        median_reasoning_tokens: 0,
      }),
    });

    // Trigger frame capture - receives degraded, sets isVisionDegraded = true
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });

    // Now send a valid non-degraded response (recovery)
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        perception: { hazard: null, hazards: [], path_clear: true, instruction: "", signage_text: [] },
        usage: { input_tokens: 100, output_tokens: 10, est_cost_usd: 0.001, finish_reason: "stop" },
        latency_ms: 100,
        client_timestamp: Date.now() / 1000,
        server_total_ms: 200,
        meta_ms: 150,
        finish_reason: "stop",
        retries_display: "0 / 0",
        median_reasoning_tokens: 0,
      }),
    });

    // Trigger next frame capture - first valid result after degraded
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });

    console.log("=== spend_blocked recovery test - Spoken messages ===");
    console.log(getSpokenMessages());

    // Should speak "Vision back" immediately (no 10s debounce)
    // This tests that Vision back is spoken even if arbiter had suppressed Vision limited
    expect(wasSpoken("Vision back")).toBe(true);
  });

  it("speaks 'Vision back' after server_vision_limited (instruction-based degraded) then valid response with hazard", async () => {
    await clickStartVision(container);
    await waitForVisionRunning();

    // Simulate server returning response with instruction "Vision limited" but NO status: "degraded"
    // This triggers the server_vision_limited branch (line 434 in App.tsx), not the degraded_received branch
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        perception: {
          // NO status: "degraded" - this is the key difference from other tests
          hazard: null,
          hazards: [],
          path_clear: false,
          instruction: "Vision limited, moving-object alerts only",
          signage_text: []
        },
        usage: { input_tokens: 100, output_tokens: 10, est_cost_usd: 0.001, finish_reason: "stop" },
        latency_ms: 100,
        client_timestamp: Date.now() / 1000,
        server_total_ms: 200,
        meta_ms: 150,
        finish_reason: "stop",
        retries_display: "0 / 0",
        median_reasoning_tokens: 0,
      }),
    });

    // Trigger frame capture - receives instruction-based degraded, sets isVisionDegraded = true
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });

    console.log("=== After first degraded response ===");
    console.log("Spoken messages:", getSpokenMessages());

    // Should have spoken "Vision limited" via server_vision_limited path
    expect(wasSpoken("Vision limited, moving-object alerts only")).toBe(true);

    // Now send a valid non-degraded response WITH a hazard (recovery)
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        perception: {
          hazard: { type: "pole", direction: "center", distance: "near", urgency: 3, confidence: 0.9 },
          hazards: [{ type: "pole", direction: "center", distance: "near", urgency: 3, confidence: 0.9 }],
          path_clear: false,
          instruction: "Pole ahead, stop",
          signage_text: []
        },
        usage: { input_tokens: 100, output_tokens: 10, est_cost_usd: 0.001, finish_reason: "stop" },
        latency_ms: 100,
        client_timestamp: Date.now() / 1000,
        server_total_ms: 200,
        meta_ms: 150,
        finish_reason: "stop",
        retries_display: "0 / 0",
        median_reasoning_tokens: 0,
      }),
    });

    // Trigger next frame capture - first valid result with hazard after degraded
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });

    console.log("=== After valid response ===");
    console.log("Spoken messages:", getSpokenMessages());

    // Should speak "Vision back" immediately (no 10s debounce)
    expect(wasSpoken("Vision back")).toBe(true);

    const recoveryUtterance = mockSpeak.mock.calls
      .map(([utterance]) => utterance as MockSpeechSynthesisUtterance)
      .find((utterance) => utterance.text === "Vision back");
    await act(async () => {
      recoveryUtterance?.onend?.();
      await Promise.resolve();
    });

    // The queued hazard is spoken after the recovery utterance finishes.
    expect(wasSpoken("Pole ahead, stop")).toBe(true);
  });
});