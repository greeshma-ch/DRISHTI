/** Emergency Demo Page (P6) — /#emergency-demo for manual testing of all states. */

import { useState, useCallback } from "react";
import { EmergencyButton } from "./EmergencyButton";
import { EmergencyScreen } from "./EmergencyScreen";
import { useEmergencyContext } from "./EmergencyContext";

interface MockContact {
  id: string;
  name: string;
  telegramChatId: string;
}

/** Demo-only contact — never sent to real endpoint */
const DEMO_CONTACT: MockContact = { id: "demo-1", name: "Demo Contact", telegramChatId: "demo-chat-id" };

/**
 * Demo page for testing emergency flow without real network calls.
 * Uses the shared EmergencyContext (single provider) with a demo flag.
 * Buttons to simulate: countdown, cancel, success, failure, offline.
 */
export function EmergencyDemoPage({ lang, setLang }: { lang: "en" | "hi"; setLang: React.Dispatch<React.SetStateAction<"en" | "hi">> }) {
  const { state, countdown, trigger, cancel, onSendResult, reset, setRecentAlerts } = useEmergencyContext();
  const [demoState, setDemoState] = useState<"idle" | "countdown" | "sending" | "success" | "failure" | "cancelled">("idle");
  const [demoCountdown, setDemoCountdown] = useState(10);
  const [demoContactName] = useState("Demo Contact");

  // Sync demo state with emergency context state for display
  // The context's state is the source of truth; demoState is only for controlling demo buttons
  const displayState = state !== "idle" ? state : demoState;
  const displayCountdown = state === "countdown" ? countdown : demoCountdown;

  const handleStartCountdown = useCallback(() => {
    setDemoState("countdown");
    setDemoCountdown(10);
    setRecentAlerts(["Vehicle ahead", "Pole left"]);
    trigger([DEMO_CONTACT], "Demo User");
  }, [trigger, setRecentAlerts]);

  const handleCancel = useCallback(() => {
    // Call the context's cancel — it will transition to cancelled then idle
    cancel();
    setDemoState("idle");
  }, [cancel]);

  const handleSimulateSuccess = useCallback(() => {
    setDemoState("success");
    onSendResult(true);
  }, [onSendResult]);

  const handleSimulateFailure = useCallback(() => {
    setDemoState("failure");
    onSendResult(false);
  }, [onSendResult]);

  const handleSimulateOffline = useCallback(() => {
    setDemoState("countdown");
    setDemoCountdown(10);
    setRecentAlerts(["Network error"]);
    trigger([DEMO_CONTACT], "Demo User");
  }, [trigger, setRecentAlerts]);

  const handleDone = useCallback(() => {
    // Reset both demo state and context state to idle
    setDemoState("idle");
    reset();
  }, [reset]);

  return (
    <main
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        minHeight: "100vh",
        background: "#0a0a0a",
        color: "#f0f0f0",
        fontFamily: "system-ui, -apple-system, sans-serif",
        padding: "1rem",
        boxSizing: "border-box",
      }}
    >
      <header style={{ width: "100%", maxWidth: "640px", marginBottom: "1rem", textAlign: "center" }}>
        <h1 style={{ margin: "0.2rem 0", fontSize: "1.8rem" }}>दृष्टि &middot; Drishti</h1>
        <p style={{ margin: 0, opacity: 0.7, fontSize: "0.9rem" }}>Emergency Demo — P6</p>
      </header>

      {/* Language Selector */}
      <section
        style={{
          width: "100%",
          maxWidth: "640px",
          marginBottom: "1rem",
          background: "#18181b",
          border: "1px solid #27272a",
          borderRadius: "8px",
          padding: "1rem",
          boxSizing: "border-box",
        }}
      >
        <h2 style={{ fontSize: "1rem", margin: "0 0 0.8rem 0", color: "#a1a1aa" }}>Language</h2>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button
            onClick={() => setLang("en")}
            style={{
              flex: 1,
              padding: "0.8rem",
              fontSize: "1rem",
              borderRadius: "8px",
              border: lang === "en" ? "2px solid #2563eb" : "1px solid #52525b",
              background: lang === "en" ? "#1e3a5f" : "#27272a",
              color: "#fafafa",
              cursor: "pointer",
            }}
          >
            English
          </button>
          <button
            onClick={() => setLang("hi")}
            style={{
              flex: 1,
              padding: "0.8rem",
              fontSize: "1rem",
              borderRadius: "8px",
              border: lang === "hi" ? "2px solid #2563eb" : "1px solid #52525b",
              background: lang === "hi" ? "#1e3a5f" : "#27272a",
              color: "#fafafa",
              cursor: "pointer",
            }}
          >
            हिन्दी
          </button>
        </div>
      </section>

      {/* Demo Controls */}
      <section
        style={{
          width: "100%",
          maxWidth: "640px",
          marginBottom: "1rem",
          background: "#18181b",
          border: "1px solid #27272a",
          borderRadius: "8px",
          padding: "1rem",
          boxSizing: "border-box",
        }}
      >
        <h2 style={{ fontSize: "1rem", margin: "0 0 0.8rem 0", color: "#a1a1aa" }}>Demo Controls</h2>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
          <button
            onClick={handleStartCountdown}
            disabled={displayState !== "idle"}
            style={{
              gridColumn: "span 2",
              padding: "1rem",
              fontSize: "1.1rem",
              fontWeight: "bold",
              borderRadius: "8px",
              border: "none",
              background: displayState === "idle" ? "#dc2626" : "#4b0000",
              color: "white",
              cursor: displayState === "idle" ? "pointer" : "not-allowed",
              opacity: displayState === "idle" ? 1 : 0.5,
            }}
          >
            🚨 Start Countdown (10s)
          </button>
          <button
            onClick={handleCancel}
            disabled={displayState !== "countdown"}
            style={{
              padding: "1rem",
              fontSize: "1rem",
              borderRadius: "8px",
              border: "none",
              background: displayState === "countdown" ? "#ca8a04" : "#422006",
              color: "white",
              cursor: displayState === "countdown" ? "pointer" : "not-allowed",
              opacity: displayState === "countdown" ? 1 : 0.5,
            }}
          >
            ⏹️ Cancel
          </button>
          <button
            onClick={handleSimulateSuccess}
            disabled={displayState !== "sending"}
            style={{
              padding: "1rem",
              fontSize: "1rem",
              borderRadius: "8px",
              border: "none",
              background: displayState === "sending" ? "#16a34a" : "#14532d",
              color: "white",
              cursor: displayState === "sending" ? "pointer" : "not-allowed",
              opacity: displayState === "sending" ? 1 : 0.5,
            }}
          >
            ✅ Simulate Success
          </button>
          <button
            onClick={handleSimulateFailure}
            disabled={displayState !== "sending"}
            style={{
              padding: "1rem",
              fontSize: "1rem",
              borderRadius: "8px",
              border: "none",
              background: displayState === "sending" ? "#dc2626" : "#4b0000",
              color: "white",
              cursor: displayState === "sending" ? "pointer" : "not-allowed",
              opacity: displayState === "sending" ? 1 : 0.5,
            }}
          >
            ❌ Simulate Failure
          </button>
          <button
            onClick={handleSimulateOffline}
            disabled={displayState !== "idle"}
            style={{
              gridColumn: "span 2",
              padding: "1rem",
              fontSize: "1rem",
              borderRadius: "8px",
              border: "1px solid #52525b",
              background: displayState === "idle" ? "#27272a" : "#1a1a1a",
              color: displayState === "idle" ? "#fafafa" : "#666",
              cursor: displayState === "idle" ? "pointer" : "not-allowed",
              opacity: displayState === "idle" ? 1 : 0.5,
            }}
          >
            📴 Simulate Offline
          </button>
          <button
            onClick={handleDone}
            disabled={displayState === "idle"}
            style={{
              gridColumn: "span 2",
              padding: "1rem",
              fontSize: "1rem",
              borderRadius: "8px",
              border: "1px solid #52525b",
              background: "#27272a",
              color: "#fafafa",
              cursor: "pointer",
            }}
          >
            🔄 Done / Reset
          </button>
        </div>
      </section>

      {/* Current State Display — shows LIVE countdown from hook */}
      <section
        style={{
          width: "100%",
          maxWidth: "640px",
          marginBottom: "1rem",
          background: "#18181b",
          border: "1px solid #27272a",
          borderRadius: "8px",
          padding: "1rem",
          boxSizing: "border-box",
        }}
      >
        <h2 style={{ fontSize: "1rem", margin: "0 0 0.8rem 0", color: "#a1a1aa" }}>State (Live from Hook)</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", fontSize: "0.9rem" }}>
          <div>
            <strong>Hook State:</strong>{" "}
            <span
              style={{
                marginLeft: "0.5rem",
                padding: "0.2rem 0.6rem",
                borderRadius: "4px",
                background:
                  state === "countdown"
                    ? "#dc2626"
                    : state === "sending"
                    ? "#ca8a04"
                    : state === "success"
                    ? "#16a34a"
                    : state === "failure"
                    ? "#dc2626"
                    : state === "cancelled"
                    ? "#facc15"
                    : "#52525b",
                color: "white",
                fontWeight: "bold",
                textTransform: "capitalize",
              }}
            >
              {state}
            </span>
          </div>
          <div>
            <strong>Display State:</strong>{" "}
            <span style={{ marginLeft: "0.5rem", color: "#38bdf8" }}>{displayState}</span>
          </div>
          <div>
            <strong>LIVE Countdown:</strong>{" "}
            <span style={{ marginLeft: "0.5rem", color: "#facc15", fontVariantNumeric: "tabular-nums", fontSize: "1.2rem", fontWeight: "bold" }}>
              {displayCountdown}s
            </span>
          </div>
          <div>
            <strong>Contact Name:</strong>{" "}
            <span style={{ marginLeft: "0.5rem", color: "#a1a1aa" }}>{demoContactName}</span>
          </div>
        </div>
      </section>

      {/* Emergency Button (real component) */}
      <section
        style={{
          width: "100%",
          maxWidth: "640px",
          marginBottom: "1rem",
          background: "#18181b",
          border: "1px solid #27272a",
          borderRadius: "8px",
          padding: "1rem",
          boxSizing: "border-box",
        }}
      >
        <h2 style={{ fontSize: "1rem", margin: "0 0 0.8rem 0", color: "#a1a1aa" }}>Emergency Button (Real Component)</h2>
        <EmergencyButton
          contacts={[DEMO_CONTACT]}
          userName="Demo User"
          lang={lang}
          disabled={displayState !== "idle"}
        />
      </section>

      {/* Emergency Screen Overlay — demoMode=true shows panels instead of real sms:/tel: */}
      <EmergencyScreen
        state={displayState}
        countdown={displayCountdown}
        contactName={demoContactName}
        lang={lang}
        onCancel={handleCancel}
        onCall112={() => {}}
        onSmsContact={() => {}}
        demoMode={true}
        onDone={handleDone}
      />

      <a
        href="/"
        style={{
          marginTop: "1rem",
          padding: "0.8rem 1.5rem",
          fontSize: "1rem",
          borderRadius: "8px",
          border: "1px solid #52525b",
          background: "#27272a",
          color: "#fafafa",
          textDecoration: "none",
        }}
      >
        ← Back to Main App
      </a>
    </main>
  );
}