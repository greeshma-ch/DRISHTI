/** EmergencyStateMachine tests (P6) — uses repo's ReactDOM test pattern */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import ReactDOM from "react-dom/client";
import { useEmergency } from "./EmergencyStateMachine";

// Test wrapper component to access hook internals
function TestEmergencyWrapper({
  lang = "en",
  onEmergencySend,
  onStateChange,
}: {
  lang?: "en" | "hi";
  onEmergencySend?: (contacts: string[], userName: string, recentAlerts: string[]) => Promise<{ ok: boolean; contactName?: string }>;
  onStateChange?: (state: ReturnType<typeof useEmergency>) => void;
}) {
  const emergency = useEmergency(lang, onEmergencySend);

  if (onStateChange) {
    onStateChange(emergency);
  }

  return null;
}

describe("useEmergency", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof ReactDOM.createRoot>;
  let capturedState: ReturnType<typeof useEmergency> | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    capturedState = null;

    // Mock speechSynthesis using vi.stubGlobal for proper typing
    vi.stubGlobal("speechSynthesis", {
      speak: vi.fn(),
      cancel: vi.fn(),
      getVoices: () => [],
      speaking: false,
      pending: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as SpeechSynthesis);

    vi.stubGlobal("SpeechSynthesisUtterance", vi.fn().mockImplementation((text: string) => ({
      text,
      lang: "",
      onend: null,
      onerror: null,
    })) as unknown as typeof SpeechSynthesisUtterance);

    // Mock AudioContext for soft beep
    const mockAudioContext = {
      createOscillator: () => ({
        type: "sine" as const,
        frequency: { value: 880 },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      }),
      createGain: () => ({
        gain: { value: 0.1 },
        connect: vi.fn(),
      }),
      destination: {},
      currentTime: 0,
    };
    vi.stubGlobal("AudioContext", vi.fn().mockImplementation(() => mockAudioContext));
    vi.stubGlobal("webkitAudioContext", vi.fn().mockImplementation(() => mockAudioContext));

    container = document.createElement("div");
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("starts in idle state", async () => {
    await act(async () => {
      root.render(
        <TestEmergencyWrapper
          onStateChange={(s) => { capturedState = s; }}
        />
      );
    });

    expect(capturedState?.state).toBe("idle");
    expect(capturedState?.countdown).toBe(10);
  });

  it("starts countdown on trigger", async () => {
    await act(async () => {
      root.render(
        <TestEmergencyWrapper
          onStateChange={(s) => { capturedState = s; }}
        />
      );
    });

    act(() => {
      capturedState?.trigger(
        [{ id: "1", name: "Test", telegramChatId: "123" }],
        "User"
      );
    });

    expect(capturedState?.state).toBe("countdown");
    expect(capturedState?.countdown).toBe(10);
  });

  it("counts down from 10 to 0 with fake timers", async () => {
    const mockSend = vi.fn().mockResolvedValue({ ok: true, contactName: "Test" });

    await act(async () => {
      root.render(
        <TestEmergencyWrapper
          onEmergencySend={mockSend}
          onStateChange={(s) => { capturedState = s; }}
        />
      );
    });

    act(() => {
      capturedState?.trigger(
        [{ id: "1", name: "Test", telegramChatId: "123" }],
        "User"
      );
    });

    expect(capturedState?.countdown).toBe(10);

    // Advance timers by 1 second
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(capturedState?.countdown).toBe(9);

    // Advance to completion (10 seconds total)
    act(() => {
      vi.advanceTimersByTime(9000);
    });

    expect(capturedState?.countdown).toBe(0);
    expect(capturedState?.state).toBe("sending");
  });

  it("cancels countdown and goes directly to idle", async () => {
    await act(async () => {
      root.render(
        <TestEmergencyWrapper
          onStateChange={(s) => { capturedState = s; }}
        />
      );
    });

    act(() => {
      capturedState?.trigger(
        [{ id: "1", name: "Test", telegramChatId: "123" }],
        "User"
      );
    });

    expect(capturedState?.state).toBe("countdown");

    act(() => {
      capturedState?.cancel();
    });

    // Cancel now goes directly to idle (not cancelled state)
    expect(capturedState?.state).toBe("idle");
    expect(capturedState?.countdown).toBe(10);
  });

  it("speaks cancelled message when cancelled", async () => {
    await act(async () => {
      root.render(
        <TestEmergencyWrapper
          onStateChange={(s) => { capturedState = s; }}
        />
      );
    });

    act(() => {
      capturedState?.trigger(
        [{ id: "1", name: "Test", telegramChatId: "123" }],
        "User"
      );
    });

    act(() => {
      capturedState?.cancel();
    });

    // Verify speechSynthesis.speak was called with cancelled message
    const speakFn = vi.mocked(window.speechSynthesis.speak);
    expect(speakFn).toHaveBeenCalled();
    const lastCall = speakFn.mock.calls[speakFn.mock.calls.length - 1];
    expect(lastCall).toBeDefined();
    const utterance = lastCall![0] as SpeechSynthesisUtterance;
    expect(utterance.text).toMatch(/cancel/i);
  });

  it("calls onSendResult with success", async () => {
    await act(async () => {
      root.render(
        <TestEmergencyWrapper
          onStateChange={(s) => { capturedState = s; }}
        />
      );
    });

    act(() => {
      capturedState?.trigger(
        [{ id: "1", name: "Test", telegramChatId: "123" }],
        "User"
      );
    });

    // Advance to sending state
    act(() => {
      vi.advanceTimersByTime(10000);
    });

    expect(capturedState?.state).toBe("sending");

    act(() => {
      capturedState?.onSendResult(true);
    });

    expect(capturedState?.state).toBe("success");
  });

  it("calls onSendResult with failure", async () => {
    await act(async () => {
      root.render(
        <TestEmergencyWrapper
          onStateChange={(s) => { capturedState = s; }}
        />
      );
    });

    act(() => {
      capturedState?.trigger(
        [{ id: "1", name: "Test", telegramChatId: "123" }],
        "User"
      );
    });

    act(() => {
      vi.advanceTimersByTime(10000);
    });

    act(() => {
      capturedState?.onSendResult(false);
    });

    expect(capturedState?.state).toBe("failure");
  });

  it("resets to idle", async () => {
    await act(async () => {
      root.render(
        <TestEmergencyWrapper
          onStateChange={(s) => { capturedState = s; }}
        />
      );
    });

    act(() => {
      capturedState?.trigger(
        [{ id: "1", name: "Test", telegramChatId: "123" }],
        "User"
      );
    });

    act(() => {
      vi.advanceTimersByTime(10000);
    });

    act(() => {
      capturedState?.onSendResult(true);
    });

    expect(capturedState?.state).toBe("success");

    act(() => {
      capturedState?.reset();
    });

    expect(capturedState?.state).toBe("idle");
    expect(capturedState?.countdown).toBe(10);
  });

  it("does not trigger if already in progress", async () => {
    await act(async () => {
      root.render(
        <TestEmergencyWrapper
          onStateChange={(s) => { capturedState = s; }}
        />
      );
    });

    act(() => {
      capturedState?.trigger(
        [{ id: "1", name: "Test", telegramChatId: "123" }],
        "User"
      );
    });

    const firstCountdown = capturedState?.countdown;

    // Try to trigger again
    act(() => {
      capturedState?.trigger(
        [{ id: "2", name: "Test2", telegramChatId: "456" }],
        "User"
      );
    });

    // Should still be in countdown with same countdown
    expect(capturedState?.state).toBe("countdown");
    expect(capturedState?.countdown).toBe(firstCountdown);
  });

  it("sets recent alerts", async () => {
    await act(async () => {
      root.render(
        <TestEmergencyWrapper
          onStateChange={(s) => { capturedState = s; }}
        />
      );
    });

    act(() => {
      capturedState?.setRecentAlerts(["Alert 1", "Alert 2", "Alert 3"]);
    });

    // Can't directly test internal ref, but we can verify it doesn't throw
    expect(capturedState?.state).toBe("idle");
  });

  it("does not make network requests during countdown (offline capable)", async () => {
    const mockSend = vi.fn().mockResolvedValue({ ok: true, contactName: "Test" });

    await act(async () => {
      root.render(
        <TestEmergencyWrapper
          onEmergencySend={mockSend}
          onStateChange={(s) => { capturedState = s; }}
        />
      );
    });

    act(() => {
      capturedState?.trigger(
        [{ id: "1", name: "Test", telegramChatId: "123" }],
        "User"
      );
    });

    // During countdown, mockSend should not be called
    expect(mockSend).not.toHaveBeenCalled();

    // Only after countdown completes
    act(() => {
      vi.advanceTimersByTime(10000);
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});