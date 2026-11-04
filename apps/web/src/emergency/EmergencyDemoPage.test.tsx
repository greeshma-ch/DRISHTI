/** EmergencyDemoPage tests (P6) — uses repo's ReactDOM test pattern */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import ReactDOM from "react-dom/client";
import RootApp from "../App";

describe("EmergencyDemoPage", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof ReactDOM.createRoot>;

  beforeEach(() => {
    // Use real timers because EmergencyDemoPage uses the real useEmergency hook
    // which has a setInterval that would loop infinitely under fake timers
    vi.useRealTimers();
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);

    // Mock speechSynthesis
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

    // Mock AudioContext
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
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it("renders without crashing", async () => {
    // Navigate to emergency-demo hash
    window.location.hash = "emergency-demo";
    window.dispatchEvent(new HashChangeEvent("hashchange"));

    await act(async () => {
      root.render(<RootApp />);
    });

    
    expect(container.textContent).toContain("दृष्टि · Drishti");
    expect(container.textContent).toContain("Emergency Demo — P6");
  });

  it("has language selector with English and Hindi", async () => {
    window.location.hash = "emergency-demo";
    window.dispatchEvent(new HashChangeEvent("hashchange"));

    await act(async () => {
      root.render(<RootApp />);
    });

    
    expect(container.textContent).toContain("English");
    expect(container.textContent).toContain("हिन्दी");
  });

  it("has demo control buttons", async () => {
    window.location.hash = "emergency-demo";
    window.dispatchEvent(new HashChangeEvent("hashchange"));

    await act(async () => {
      root.render(<RootApp />);
    });

    
    expect(container.textContent).toContain("Start Countdown");
    expect(container.textContent).toContain("Cancel");
    expect(container.textContent).toContain("Simulate Success");
    expect(container.textContent).toContain("Simulate Failure");
    expect(container.textContent).toContain("Simulate Offline");
    expect(container.textContent).toContain("Done / Reset");
  });

  it("Start Countdown button is enabled initially", async () => {
    window.location.hash = "emergency-demo";
    window.dispatchEvent(new HashChangeEvent("hashchange"));

    await act(async () => {
      root.render(<RootApp />);
    });

    
    const startButton = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Start Countdown")
    );
    expect(startButton).not.toBeNull();
    expect(startButton?.hasAttribute("disabled")).toBe(false);
  });

  it("Cancel button is disabled initially", async () => {
    window.location.hash = "emergency-demo";
    window.dispatchEvent(new HashChangeEvent("hashchange"));

    await act(async () => {
      root.render(<RootApp />);
    });

    
    const cancelButton = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Cancel")
    );
    expect(cancelButton).not.toBeNull();
    expect(cancelButton?.hasAttribute("disabled")).toBe(true);
  });

  it("Simulate Success/Failure buttons are disabled initially", async () => {
    window.location.hash = "emergency-demo";
    window.dispatchEvent(new HashChangeEvent("hashchange"));

    await act(async () => {
      root.render(<RootApp />);
    });

    
    const successButton = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Simulate Success")
    );
    const failureButton = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Simulate Failure")
    );

    expect(successButton).not.toBeNull();
    expect(failureButton).not.toBeNull();
    expect(successButton?.hasAttribute("disabled")).toBe(true);
    expect(failureButton?.hasAttribute("disabled")).toBe(true);
  });

  it("clicking Start Countdown enables Cancel button", async () => {
    window.location.hash = "emergency-demo";
    window.dispatchEvent(new HashChangeEvent("hashchange"));

    await act(async () => {
      root.render(<RootApp />);
    });

    
    const startButton = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Start Countdown")
    );

    await act(async () => {
      startButton?.click();
    });

    
    const cancelButton = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Cancel")
    );
    expect(cancelButton?.hasAttribute("disabled")).toBe(false);
  });

  it("clicking Cancel resets to idle", async () => {
    window.location.hash = "emergency-demo";
    window.dispatchEvent(new HashChangeEvent("hashchange"));

    await act(async () => {
      root.render(<RootApp />);
    });

    
    const startButton = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Start Countdown")
    );

    await act(async () => {
      startButton?.click();
    });

    
    const cancelButton = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Cancel")
    );

    await act(async () => {
      cancelButton?.click();
    });

    
    // Should be back to idle state
    const startButtonAgain = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Start Countdown")
    );
    expect(startButtonAgain?.hasAttribute("disabled")).toBe(false);

    const cancelButtonAgain = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Cancel")
    );
    expect(cancelButtonAgain?.hasAttribute("disabled")).toBe(true);
  });

  it("displays state information", async () => {
    window.location.hash = "emergency-demo";
    window.dispatchEvent(new HashChangeEvent("hashchange"));

    await act(async () => {
      root.render(<RootApp />);
    });


    expect(container.textContent).toContain("Display State");
    expect(container.textContent).toContain("Hook State");
    expect(container.textContent).toContain("LIVE Countdown");
    expect(container.textContent).toContain("Contact Name");
  });

  it("renders EmergencyButton component", async () => {
    window.location.hash = "emergency-demo";
    window.dispatchEvent(new HashChangeEvent("hashchange"));

    await act(async () => {
      root.render(<RootApp />);
    });

    
    // New aria-label is "SOS — tap 3 times for help" / "SOS — सहायता के लिए ३ बार टैप करें"
    const emergencyButton = container.querySelector("button[aria-label*='SOS']");
    expect(emergencyButton).not.toBeNull();
  });

  it("has back link to main app", async () => {
    window.location.hash = "emergency-demo";
    window.dispatchEvent(new HashChangeEvent("hashchange"));

    await act(async () => {
      root.render(<RootApp />);
    });

    
    const backLink = container.querySelector("a[href='/']");
    expect(backLink).not.toBeNull();
    expect(backLink?.textContent).toContain("Back to Main App");
  });

  it("no real fetch calls are made for emergency send (demo mode)", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    } as Response);

    window.location.hash = "emergency-demo";
    window.dispatchEvent(new HashChangeEvent("hashchange"));

    await act(async () => {
      root.render(<RootApp />);
    });


    const startButton = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Start Countdown")
    );

    await act(async () => {
      startButton?.click();
    });


    // Auth init may be called on mount, but emergency send should not be called in demo mode
    const emergencySendCalls = fetchSpy.mock.calls.filter((call) =>
      typeof call[0] === "string" && call[0].includes("/emergency")
    );
    expect(emergencySendCalls).toHaveLength(0);

    fetchSpy.mockRestore();
  });
});