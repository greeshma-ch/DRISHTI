/** Vision Recovery Event Log Test. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import ReactDOM from "react-dom/client";
import MainApp from "./App";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let mockFetch: ReturnType<typeof vi.fn>;
let mockSpeak: ReturnType<typeof vi.fn>;
let mockCancel: ReturnType<typeof vi.fn>;
let mockGetVoices: ReturnType<typeof vi.fn>;

const mockOscillator = { connect: vi.fn(), start: vi.fn(), stop: vi.fn(), type: "sine", frequency: { setValueAtTime: vi.fn() } };
const mockGainNode = { connect: vi.fn(), gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() } };
const mockAudioContext = { createOscillator: vi.fn(() => mockOscillator), createGain: vi.fn(() => mockGainNode), destination: {}, currentTime: 0, state: "running", resume: vi.fn().mockResolvedValue(undefined) };

class MockSpeechSynthesisUtterance {
  text: string; lang = "en-IN"; volume = 1; voice: SpeechSynthesisVoice | null = null;
  onstart: (() => void) | null = null; onend: (() => void) | null = null; onerror: (() => void) | null = null;
  constructor(text: string) { this.text = text; }
}

function renderApp() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOM.createRoot(container);
  act(() => { root.render(<MainApp />); });
  return { container, root };
}

async function clickStartVision(container: HTMLElement) {
  const startButton = container.querySelector("button");
  if (startButton) {
    await act(async () => { startButton.click(); await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
  }
}

async function waitForVisionRunning(container: HTMLElement) {
  await act(async () => {
    for (let i = 0; i < 20; i++) {
      const statusEl = container.querySelector('[style*="rgba(0,0,0,0.75)"]');
      if (statusEl?.textContent?.includes("Vision running")) break;
      await vi.advanceTimersByTimeAsync(50);
    }
    await Promise.resolve();
  });
}

function getVisionEvents(container: HTMLElement) {
  const logEl = container.querySelector('[style*="font-family: monospace"]');
  return logEl?.textContent || "";
}

describe("Vision Recovery Event Log", () => {
  let container: HTMLElement;
  let root: ReactDOM.Root;

  beforeEach(() => {
    vi.useFakeTimers();
    const createMockResponse = (overrides = {}) => Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: async () => ({ version: 1, clips: { hazards: {}, system: {} } }), ...overrides });
    mockFetch = vi.fn().mockImplementation(() => createMockResponse());
    global.fetch = mockFetch;
    mockSpeak = vi.fn(); mockCancel = vi.fn(); mockGetVoices = vi.fn().mockReturnValue([{ lang: "en-US", name: "English" }, { lang: "hi-IN", name: "Hindi" }]);
    Object.defineProperty(window, "SpeechSynthesisUtterance", { value: MockSpeechSynthesisUtterance, writable: true, configurable: true });
    Object.defineProperty(window, "speechSynthesis", { value: { speak: mockSpeak, cancel: mockCancel, getVoices: mockGetVoices, speaking: false, pending: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }, writable: true, configurable: true });
    Object.defineProperty(window, "AudioContext", { value: vi.fn(() => mockAudioContext), writable: true, configurable: true });
    Object.defineProperty(window, "webkitAudioContext", { value: vi.fn(() => mockAudioContext), writable: true, configurable: true });
    const mockGetUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] });
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: mockGetUserMedia }, writable: true });
    Object.defineProperty(HTMLMediaElement.prototype, "play", { configurable: true, value: vi.fn().mockResolvedValue(undefined) });
    Object.defineProperty(HTMLMediaElement.prototype, "readyState", { configurable: true, value: 4 });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn(), fillRect: vi.fn() } as never);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => callback(new Blob(["test"], { type: "image/jpeg" })));
    if (root) { act(() => { root.unmount(); }); }
    if (container) { container.remove(); }
    const rendered = renderApp(); container = rendered.container; root = rendered.root;
  });

  afterEach(() => { vi.useRealTimers(); if (root) { act(() => { root.unmount(); }); } if (container) { container.remove(); } });

  it("shows vision_back_decision and vision_back_spoken in event log", async () => {
    await clickStartVision(container);
    await waitForVisionRunning(container);

    // First: degraded response (server_vision_limited)
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ perception: { hazard: null, hazards: [], path_clear: false, instruction: "Vision limited, moving-object alerts only", signage_text: [] }, usage: { input_tokens: 100, output_tokens: 10, est_cost_usd: 0.001, finish_reason: "stop" }, latency_ms: 100, client_timestamp: Date.now() / 1000, server_total_ms: 200, meta_ms: 150, finish_reason: "stop", retries_display: "0 / 0", median_reasoning_tokens: 0 }) });
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });

    // Second: valid response with hazard (recovery)
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ perception: { hazard: { type: "pole", direction: "center", distance: "near", urgency: 3, confidence: 0.9 }, hazards: [{ type: "pole", direction: "center", distance: "near", urgency: 3, confidence: 0.9 }], path_clear: false, instruction: "Pole ahead", signage_text: [] }, usage: { input_tokens: 100, output_tokens: 10, est_cost_usd: 0.001, finish_reason: "stop" }, latency_ms: 100, client_timestamp: Date.now() / 1000, server_total_ms: 200, meta_ms: 150, finish_reason: "stop", retries_display: "0 / 0", median_reasoning_tokens: 0 }) });
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });

    // Get event log from UI
    const eventLog = getVisionEvents(container);
    console.log("=== EVENT LOG ===");
    console.log(eventLog);

    // Verify key events
    expect(eventLog).toContain("vision_back_decision");
    expect(eventLog).toContain("vision_back_spoken");
    expect(eventLog).toContain("server_vision_limited");
    expect(eventLog).toContain("vision_limited_spoken");
  });
});