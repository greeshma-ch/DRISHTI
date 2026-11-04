/** Emergency Screen (P6) — full-screen overlay during countdown/sending/success/failure. */

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { getSystemMessage } from "../phrases";
import { useEmergencyContextOptional } from "./EmergencyContext";
import type { EmergencyEvent } from "./EmergencyStateMachine";

// Single source of truth for "Back in Drishti" text per state
function getBackInDrishtiText(lang: "en" | "hi"): string {
  return lang === "hi" ? "ड्रिस्टी में वापस। पूर्ण करने के लिए कहीं भी टैप करें।" : "Back in Drishti. Tap anywhere to finish.";
}

interface EmergencyScreenProps {
  // Now gets state from context; these props are optional for backward compat with tests
  state?: "idle" | "countdown" | "sending" | "success" | "failure" | "cancelled";
  countdown?: number; // 10..0 during countdown
  contactName?: string;
  lang?: "en" | "hi";
  onCancel?: () => void;
  onCall112?: () => void;
  onSmsContact?: () => void;
  demoMode?: boolean;
  onDone?: () => void; // Called when Done button pressed (returns to idle)
  httpStatus?: number;
  lastRequestUrl?: string;
  lastError?: string;
  eventLog?: EmergencyEvent[];
  clearEventLog?: () => void;
}

interface TelLinkState {
  tapped: boolean;
}

interface BackInDrishtiState {
  active: boolean;
  tapCount: number;
}

/**
 * Full-screen overlay during emergency flow.
 * - Countdown: shows large countdown text, plays soft beep, tap ANYWHERE to cancel
 * - Sending: shows spinner
 * - Success: speaks confirmation, whole screen shows tel:112 link (requires user gesture)
 * - Failure: speaks failure once, whole screen is SMS target (touch handler), 1s long press for 112
 * - All terminal screens have a "Done" button (64px tall, first focusable, spoken) + Android Back support
 * - Demo mode: shows panel instead of real sms:/tel: links
 * - Auto-return to idle after 90s on terminal screens
 * - Event log shown on terminal screens and under ?debug=1 with "Copy log" button
 * - visibilitychange handler for "Back in Drishti" flow
 * - Done button logs pointerdown, click, handler, instanceId, state under ?debug=1
 */
export function EmergencyScreen({
  state: propState,
  countdown: propCountdown,
  contactName: propContactName,
  lang: propLang,
  onCancel,
  onCall112,
  demoMode = false,
  onDone,
  httpStatus,
  lastRequestUrl,
  lastError,
  eventLog: propEventLog = [],
}: EmergencyScreenProps) {
  const context = useEmergencyContextOptional();

  // Use props if provided (for tests), otherwise use context
  const state = propState ?? context?.state ?? "idle";
  const countdown = propCountdown ?? context?.countdown ?? 0;
  const contactName = propContactName ?? context?.contactName;
  const lang = propLang ?? context?.lang ?? "en";
  const cancel = onCancel ?? context?.cancel ?? (() => {});
  const reset = context?.reset ?? (() => {});
  const clearEventLog = context?.clearEventLog ?? (() => {});
  const instanceId = context?.instanceId ?? "test-instance";
  const lastGpsPosition = context?.lastGpsPosition ?? null;
  const eventLog = propEventLog.length > 0 ? propEventLog : (context?.eventLog ?? []);

  const [showSuccessUI, setShowSuccessUI] = useState(false);
  const [showFailureUI, setShowFailureUI] = useState(false);
  const [showCancelledUI, setShowCancelledUI] = useState(false);
  const [telLinkState, setTelLinkState] = useState<TelLinkState>({ tapped: false });
  const [backInDrishti, setBackInDrishti] = useState<BackInDrishtiState>({ active: false, tapCount: 0 });
  const autoReturnTimerRef = useRef<number | null>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const longPressTimerRef = useRef<number | null>(null);
  const failureSpokenRef = useRef(false);

  // Check if debug mode is enabled
  const debugMode = useMemo(() => {
    if (typeof window === "undefined") return false;
    const params = new URLSearchParams(window.location.search);
    return params.get("debug") === "1";
  }, [state, countdown]);

  // Inject keyframes animation once
  useEffect(() => {
    const styleId = "emergency-spin-keyframes";
    if (document.getElementById(styleId)) return;
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      @keyframes spin {
        to { transform: rotate(360deg); }
      }
    `;
    document.head.appendChild(style);
    return () => {
      const existing = document.getElementById(styleId);
      if (existing) existing.remove();
    };
  }, []);

  // Handle state transitions for success/failure/cancelled
  useEffect(() => {
    if (state === "success") {
      setShowSuccessUI(true);
      setTelLinkState({ tapped: false });
      failureSpokenRef.current = false;
      // Auto-return after 90s
      autoReturnTimerRef.current = window.setTimeout(() => {
        if (onDoneRef.current) onDoneRef.current();
      }, 90000);
    } else {
      setShowSuccessUI(false);
      if (autoReturnTimerRef.current) {
        clearTimeout(autoReturnTimerRef.current);
        autoReturnTimerRef.current = null;
      }
    }
  }, [state]);

  useEffect(() => {
    if (state === "failure") {
      setShowFailureUI(true);
      setTelLinkState({ tapped: false });
      failureSpokenRef.current = false;
      // Auto-return after 90s
      autoReturnTimerRef.current = window.setTimeout(() => {
        if (onDoneRef.current) onDoneRef.current();
      }, 90000);
    } else {
      setShowFailureUI(false);
      if (autoReturnTimerRef.current) {
        clearTimeout(autoReturnTimerRef.current);
        autoReturnTimerRef.current = null;
      }
    }
  }, [state]);

  useEffect(() => {
    if (state === "cancelled") {
      setShowCancelledUI(true);
      // Auto-return after 90s
      autoReturnTimerRef.current = window.setTimeout(() => {
        if (onDoneRef.current) onDoneRef.current();
      }, 90000);
    } else {
      setShowCancelledUI(false);
      if (autoReturnTimerRef.current) {
        clearTimeout(autoReturnTimerRef.current);
        autoReturnTimerRef.current = null;
      }
    }
  }, [state]);

  // Handle Android Back button: push state on terminal screens, pop returns to idle
  useEffect(() => {
    const isTerminal = state === "success" || state === "failure" || state === "cancelled";
    if (isTerminal) {
      window.history.pushState({ emergencyScreen: true }, "");
    }
    const handlePopState = (e: PopStateEvent) => {
      if (e.state?.emergencyScreen && onDoneRef.current) {
        // Return to idle WITHOUT pushing another state
        onDoneRef.current();
      }
    };
    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, [state]);

  // Handle pointerdown anywhere on overlay during countdown to cancel
  const handleOverlayPointerDown = useCallback((e: React.PointerEvent) => {
    if (state === "countdown") {
      e.stopPropagation();
      cancel();
    }
  }, [state, cancel]);

  const handleOverlayTouchStart = useCallback((e: React.TouchEvent) => {
    if (state === "countdown") {
      e.stopPropagation();
      cancel();
    }
  }, [state, cancel]);

  // Build SMS body with contact name, maps link from cached GPS, and timestamp
  const buildSmsBody = useCallback(() => {
    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const dateStr = now.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
    const mapsLink = lastGpsPosition
      ? `https://maps.google.com/?q=${lastGpsPosition.lat},${lastGpsPosition.lon}`
      : "Location unavailable";
    const name = contactName || "contact";
    return `Drishti emergency alert from ${name} at ${timeStr} on ${dateStr}. Location: ${mapsLink}. Please check on me.`;
  }, [contactName, lastGpsPosition]);

  // Handle Done button press with debug logging
  const handleDone = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    const eventType = e.type;
    const target = e.currentTarget;
    const pointerDownTime = (target as HTMLElement).dataset.pointerDownTime;
    const pointerDownElapsed = pointerDownTime ? Date.now() - parseInt(pointerDownTime, 10) : null;

    if (debugMode) {
      const logData = {
        event: "done_button",
        type: eventType,
        pointerDownElapsed,
        instanceId,
        state: state,
        timestamp: Date.now(),
        url: window.location.href,
      };
      console.log("[EmergencyScreen] Done button:", JSON.stringify(logData));
    }

    // Reset single state machine and clear history
    reset();
    clearEventLog();
    if (onDoneRef.current) onDoneRef.current();
  }, [debugMode, instanceId, state, reset, clearEventLog]);

  // Track pointerdown time for debug logging
  const handleDonePointerDown = useCallback((e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).dataset.pointerDownTime = Date.now().toString();
  }, []);

  // Handle 112 link tap (for success screen)
  const handleTelTap = useCallback(() => {
    setTelLinkState({ tapped: true });
    onCall112?.();
  }, [onCall112]);

  // Handle long press on failure screen for 112
  const handleLongPressStart = useCallback((e: React.TouchEvent | React.MouseEvent) => {
    if (state !== "failure" || demoMode) return;
    e.preventDefault();
    longPressTimerRef.current = window.setTimeout(() => {
      setTelLinkState({ tapped: true });
      onCall112?.();
      // Speak "Back in Drishti" after 112
      const backMsg = getSystemMessage("emergency_back_in_drishti", lang);
      if (backMsg && typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(backMsg);
        utterance.lang = lang === "hi" ? "hi-IN" : "en-IN";
        window.speechSynthesis.speak(utterance);
      }
      setBackInDrishti({ active: true, tapCount: 0 });
    }, 1000); // 1 second long press
  }, [state, demoMode, lang, onCall112]);

  const handleLongPressEnd = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  // Handle tap on failure screen for SMS (voice-first: whole screen is SMS target)
  const handleFailureScreenTap = useCallback(() => {
    if (state !== "failure" || demoMode) return;
    // If back in drishti mode, any tap returns to idle
    if (backInDrishti.active) {
      setBackInDrishti({ active: false, tapCount: 0 });
      reset();
      clearEventLog();
      return;
    }
    // Otherwise open SMS
    const smsBody = buildSmsBody();
    const smsUrl = `sms:${encodeURIComponent(smsBody)}`;
    // Use window.open for SMS to avoid navigation
    window.open(smsUrl, "_blank");
  }, [state, demoMode, backInDrishti.active, contactName, buildSmsBody, reset, clearEventLog]);

  // Speak failure message once when failure screen first appears
  useEffect(() => {
    if (showFailureUI && !failureSpokenRef.current && typeof window !== "undefined" && "speechSynthesis" in window) {
      failureSpokenRef.current = true;
      const baseMessage = getSystemMessage("emergency_failed", lang)?.replace("{name}", contactName || "contact") || "";
      // SMS instruction: only the 112 part, since baseMessage already says "Tap anywhere to text {name}"
      const smsInstruction = lang === "hi"
        ? "११२ कॉल करने के लिए टच करके रखें।"
        : "Touch and hold for 1 second to call 112.";
      const fullMessage = `${baseMessage} ${smsInstruction}`;
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(fullMessage);
      utterance.lang = lang === "hi" ? "hi-IN" : "en-IN";
      window.speechSynthesis.speak(utterance);
    }
    // Reset spoken flag when failure UI is hidden
    if (!showFailureUI) {
      failureSpokenRef.current = false;
    }
  }, [showFailureUI, lang, contactName]);

  // visibilitychange handler for "Back in Drishti" flow
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible" && (state === "success" || state === "failure")) {
        // User returned from sms:/tel: - speak "Back in Drishti" only if not already spoken
        if (!backInDrishti.active) {
          const backMsg = getSystemMessage("emergency_back_in_drishti", lang);
          if (backMsg && typeof window !== "undefined" && "speechSynthesis" in window) {
            window.speechSynthesis.cancel();
            const utterance = new SpeechSynthesisUtterance(backMsg);
            utterance.lang = lang === "hi" ? "hi-IN" : "en-IN";
            window.speechSynthesis.speak(utterance);
          }
        }
        setBackInDrishti({ active: true, tapCount: 0 });
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [state, lang, backInDrishti.active]);

  // Copy event log to clipboard
  const copyEventLog = useCallback(async () => {
    const logText = eventLog
      .map((e) => {
        const time = new Date(e.timestamp).toISOString();
        const parts = [`[${time}]`, e.type.toUpperCase()];
        if (e.state) parts.push(`state=${e.state}`);
        if (e.url) parts.push(`url=${e.url}`);
        if (e.method) parts.push(`method=${e.method}`);
        if (e.status !== undefined) parts.push(`status=${e.status}`);
        if (e.error) parts.push(`error=${e.error}`);
        if (e.message) parts.push(`msg="${e.message}"`);
        return parts.join(" ");
      })
      .join("\n");
    try {
      await navigator.clipboard.writeText(logText);
    } catch {
      // Clipboard API may fail in some contexts
    }
  }, [eventLog]);

  // Render event log panel
  const renderEventLog = (title: string) => {
    if (eventLog.length === 0) return null;

    return (
      <div
        style={{
          marginTop: "2rem",
          padding: "1rem",
          background: "rgba(0,0,0,0.5)",
          borderRadius: "8px",
          border: "1px solid #3f3f46",
          maxWidth: "640px",
          width: "100%",
          boxSizing: "border-box",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
          <div style={{ fontWeight: "bold", color: "#38bdf8" }}>{title}</div>
          <button
            onClick={copyEventLog}
            style={{
              padding: "0.5rem 1rem",
              fontSize: "0.9rem",
              borderRadius: "6px",
              border: "1px solid #52525b",
              background: "#27272a",
              color: "#fafafa",
              cursor: "pointer",
            }}
          >
            Copy log
          </button>
        </div>
        <div
          style={{
            fontFamily: "monospace",
            fontSize: "0.65rem",
            lineHeight: "1.5",
            maxHeight: "200px",
            overflow: "auto",
            background: "#0a0a0a",
            padding: "0.5rem",
            borderRadius: "4px",
            border: "1px solid #27272a",
            whiteSpace: "pre-wrap",
            color: "#a1a1aa",
          }}
        >
          {eventLog
            .map((e) => {
              const time = new Date(e.timestamp).toLocaleTimeString();
              const parts = [`[${time}]`, e.type.toUpperCase()];
              if (e.state) parts.push(`state=${e.state}`);
              if (e.url) parts.push(`url=${e.url}`);
              if (e.method) parts.push(`method=${e.method}`);
              if (e.status !== undefined) parts.push(`status=${e.status}`);
              if (e.error) parts.push(`error=${e.error}`);
              if (e.message) parts.push(`msg="${e.message}"`);
              return parts.join(" ");
            })
            .join("\n")}
        </div>
      </div>
    );
  };

  // Render countdown text
  const renderCountdown = () => {
    if (state !== "countdown") return null;

    const instruction = getSystemMessage("emergency_countdown_instruction", lang);
    const countText = countdown > 0 ? String(countdown) : "Sending...";

    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "1.5rem",
          textAlign: "center",
          width: "100%",
          maxWidth: "640px",
        }}
        role="alert"
        aria-live="assertive"
      >
        <div
          style={{
            fontSize: "clamp(4rem, 20vw, 8rem)",
            fontWeight: "bold",
            color: "#ef4444",
            fontVariantNumeric: "tabular-nums",
            lineHeight: 1,
            textShadow: "0 0 20px rgba(239, 68, 68, 0.5)",
          }}
          aria-live="polite"
        >
          {countText}
        </div>
        {instruction && (
          <div
            style={{
              fontSize: "clamp(1rem, 3vw, 1.3rem)",
              color: "#fafafa",
              maxWidth: "80%",
              opacity: 0.9,
            }}
          >
            {instruction}
          </div>
        )}
        {/* Large cancel button at bottom of countdown screen */}
        <button
          onClick={cancel}
          onTouchStart={(e) => e.stopPropagation()}
          style={{
            marginTop: "2rem",
            padding: "1.25rem 2.5rem",
            fontSize: "clamp(1.1rem, 3vw, 1.5rem)",
            fontWeight: "bold",
            borderRadius: "12px",
            border: "2px solid #fafafa",
            background: "rgba(255,255,255,0.15)",
            color: "#fafafa",
            cursor: "pointer",
            backdropFilter: "blur(4px)",
            minWidth: "200px",
            touchAction: "manipulation",
          }}
          aria-label={lang === "hi" ? "आपातकाल रद्द करें" : "Cancel emergency"}
        >
          ✕ {lang === "hi" ? "रद्द करें" : "Cancel"}
        </button>
      </div>
    );
  };

  // Render sending state
  const renderSending = () => {
    if (state !== "sending") return null;

    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "1.5rem",
        }}
        role="status"
        aria-live="polite"
      >
        <div
          style={{
            width: "80px",
            height: "80px",
            border: "6px solid #3f3f46",
            borderTopColor: "#ef4444",
            borderRadius: "50%",
            animation: "spin 1s linear infinite",
          }}
        />
        <div style={{ fontSize: "1.5rem", color: "#fafafa" }}>
          {lang === "hi" ? "संदेश भेजा जा रहा है..." : "Sending help message..."}
        </div>
      </div>
    );
  };

  // Render success state
  const renderSuccess = () => {
    if (!showSuccessUI) return null;

    const message = getSystemMessage("emergency_sent", lang);

    // Done button - first focusable element (large, 64px tall)
    const doneButton = (
      <button
        onClick={handleDone}
        onPointerDown={handleDonePointerDown}
        autoFocus
        style={{
          marginTop: "2rem",
          padding: "1.5rem 3rem",
          fontSize: "clamp(1.2rem, 3.5vw, 1.7rem)",
          fontWeight: "bold",
          borderRadius: "12px",
          border: "none",
          background: "#2563eb",
          color: "white",
          cursor: "pointer",
          minHeight: "64px",
          minWidth: "200px",
          touchAction: "manipulation",
        }}
        aria-label="Done"
      >
        Done
      </button>
    );

    if (demoMode) {
      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "1.5rem",
            textAlign: "center",
            padding: "2rem",
          }}
          role="dialog"
          aria-modal="true"
          aria-label="Emergency sent (demo)"
        >
          <div style={{ fontSize: "4rem" }}>✅</div>
          <div
            style={{
              fontSize: "clamp(1.2rem, 4vw, 1.8rem)",
              color: "#4ade80",
              maxWidth: "90%",
              fontWeight: "600",
            }}
          >
            {message}
          </div>
          <div
            style={{
              fontSize: "clamp(1rem, 3vw, 1.3rem)",
              color: "#a1a1aa",
              marginTop: "0.5rem",
            }}
          >
            {lang === "hi" ? "डेमो मोड: यह ११२ कॉल खोलेगा" : "Demo mode: This would open 112 call"}
          </div>
          {doneButton}
        </div>
      );
    }

    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "1.5rem",
          textAlign: "center",
        }}
        role="dialog"
        aria-modal="true"
        aria-label={message}
      >
        <div style={{ fontSize: "4rem" }}>✅</div>
        <div
          style={{
            fontSize: "clamp(1.2rem, 4vw, 1.8rem)",
            color: "#4ade80",
            maxWidth: "90%",
            fontWeight: "600",
          }}
        >
          {message}
        </div>
        {/* tel:112 as plain <a href> link - tapping does not unload the app */}
        <a
          href="tel:112"
          onClick={handleTelTap}
          style={{
            display: "inline-block",
            marginTop: "1rem",
            padding: "1rem 2rem",
            fontSize: "clamp(1.1rem, 3vw, 1.5rem)",
            fontWeight: "bold",
            borderRadius: "12px",
            border: "2px solid #22c55e",
            background: "rgba(34, 197, 94, 0.15)",
            color: "#22c55e",
            textDecoration: "none",
            minWidth: "200px",
            textAlign: "center",
          }}
        >
          📞 112
        </a>
        {telLinkState.tapped && (
          <div
            style={{
              marginTop: "1rem",
              fontSize: "clamp(1rem, 3vw, 1.3rem)",
              color: "#4ade80",
              fontWeight: "600",
            }}
          >
            {getBackInDrishtiText(lang)}
          </div>
        )}
        {doneButton}
        {debugMode && renderEventLog("Event Log")}
        {debugMode && (
          <div style={{ marginTop: "1rem", fontSize: "0.8rem", color: "#facc15", fontFamily: "monospace" }}>
            HTTP Status: {httpStatus ?? "—"} | Request: {lastRequestUrl ?? "—"} | Error: {lastError ?? "—"}
          </div>
        )}
      </div>
    );
  };

  // Render failure state - voice-first terminal screen
  const renderFailure = () => {
    if (!showFailureUI) return null;

    const baseMessage = getSystemMessage("emergency_failed", lang)?.replace("{name}", contactName || "contact") || "";
    // SMS instruction: only the 112 part, since baseMessage already says "Tap anywhere to text {name}"
    const smsInstruction = lang === "hi"
      ? "११२ कॉल करने के लिए टच करके रखें।"
      : "Touch and hold for 1 second to call 112.";
    const fullMessage = `${baseMessage} ${smsInstruction}`;

    // Done button - first focusable element (large, 64px tall)
    const doneButton = (
      <button
        onClick={handleDone}
        onPointerDown={handleDonePointerDown}
        autoFocus
        style={{
          marginTop: "2rem",
          padding: "1.5rem 3rem",
          fontSize: "clamp(1.2rem, 3.5vw, 1.7rem)",
          fontWeight: "bold",
          borderRadius: "12px",
          border: "none",
          background: "#2563eb",
          color: "white",
          cursor: "pointer",
          minHeight: "64px",
          minWidth: "200px",
          touchAction: "manipulation",
        }}
        aria-label="Done"
      >
        Done
      </button>
    );

    if (demoMode) {
      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "1.5rem",
            textAlign: "center",
            padding: "2rem",
          }}
          role="dialog"
          aria-modal="true"
          aria-label="Emergency failed (demo)"
        >
          <div style={{ fontSize: "4rem" }}>❌</div>
          <div
            style={{
              fontSize: "clamp(1.2rem, 4vw, 1.8rem)",
              color: "#ef4444",
              maxWidth: "90%",
              fontWeight: "600",
            }}
          >
            {fullMessage}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.8rem", width: "100%", maxWidth: "300px" }}>
            <div
              style={{
                padding: "1rem 1.5rem",
                fontSize: "1.2rem",
                fontWeight: "bold",
                borderRadius: "8px",
                border: "none",
                background: "#2563eb",
                color: "white",
              }}
            >
              📱 {lang === "hi" ? "यह संपर्क को SMS खोलेगा" : "This would open SMS to contact"}
            </div>
            <div
              style={{
                padding: "1rem 1.5rem",
                fontSize: "1.2rem",
                fontWeight: "bold",
                borderRadius: "8px",
                border: "2px solid #ef4444",
                background: "transparent",
                color: "#ef4444",
              }}
            >
              📞 {lang === "hi" ? "यह ११२ डायल करेगा (1 सेकंड दबाए रखें)" : "This would dial 112 (hold 1s)"}
            </div>
          </div>
          {doneButton}
        </div>
      );
    }

    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "1.5rem",
          textAlign: "center",
        }}
        role="alert"
        aria-live="assertive"
        // Whole screen is SMS target via touch handler
        onTouchStart={handleFailureScreenTap}
        onTouchEnd={handleLongPressEnd}
        onTouchCancel={handleLongPressEnd}
        onMouseDown={handleLongPressStart}
        onMouseUp={handleLongPressEnd}
        onMouseLeave={handleLongPressEnd}
        onClick={handleFailureScreenTap}
      >
        <div style={{ fontSize: "4rem" }}>❌</div>
        <div
          style={{
            fontSize: "clamp(1.2rem, 4vw, 1.8rem)",
            color: "#ef4444",
            maxWidth: "90%",
            fontWeight: "600",
          }}
          aria-hidden="true"
        >
          {fullMessage}
        </div>
        {/* Debug: show SMS body that would be sent */}
        {debugMode && lastGpsPosition && (
          <div style={{ marginTop: "1rem", fontSize: "0.75rem", color: "#a1a1aa", fontFamily: "monospace", maxWidth: "90%", textAlign: "left" }}>
            <strong>SMS body:</strong> {buildSmsBody()}
          </div>
        )}
        {backInDrishti.active && (
          <div
            style={{
              marginTop: "1rem",
              fontSize: "clamp(1rem, 3vw, 1.3rem)",
              color: "#facc15",
              fontWeight: "600",
            }}
          >
            {getBackInDrishtiText(lang)}
          </div>
        )}
        {doneButton}
        {debugMode && renderEventLog("Event Log")}
        {debugMode && (
          <div style={{ marginTop: "1rem", fontSize: "0.8rem", color: "#facc15", fontFamily: "monospace" }}>
            HTTP Status: {httpStatus ?? "—"} | Request: {lastRequestUrl ?? "—"} | Error: {lastError ?? "—"}
          </div>
        )}
      </div>
    );
  };

  // Render cancelled state
  const renderCancelled = () => {
    if (!showCancelledUI) return null;

    const message = getSystemMessage("emergency_cancelled", lang);

    // Done button - first focusable element (large, 64px tall)
    const doneButton = (
      <button
        onClick={handleDone}
        onPointerDown={handleDonePointerDown}
        autoFocus
        style={{
          marginTop: "2rem",
          padding: "1.5rem 3rem",
          fontSize: "clamp(1.2rem, 3.5vw, 1.7rem)",
          fontWeight: "bold",
          borderRadius: "12px",
          border: "none",
          background: "#2563eb",
          color: "white",
          cursor: "pointer",
          minHeight: "64px",
          minWidth: "200px",
          touchAction: "manipulation",
        }}
        aria-label="Done"
      >
        Done
      </button>
    );

    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "1.5rem",
          textAlign: "center",
          padding: "2rem",
        }}
        role="dialog"
        aria-modal="true"
        aria-label="Emergency cancelled"
      >
        <div style={{ fontSize: "4rem" }}>⏹️</div>
        <div
          style={{
            fontSize: "clamp(1.2rem, 4vw, 1.8rem)",
            color: "#facc15",
            maxWidth: "90%",
            fontWeight: "600",
          }}
        >
          {message}
        </div>
        {doneButton}
        {debugMode && renderEventLog("Event Log")}
        {debugMode && (
          <div style={{ marginTop: "1rem", fontSize: "0.8rem", color: "#facc15", fontFamily: "monospace" }}>
            HTTP Status: {httpStatus ?? "—"} | Request: {lastRequestUrl ?? "—"} | Error: {lastError ?? "—"}
          </div>
        )}
      </div>
    );
  };

  // Only render when not idle
  if (state === "idle") return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(0, 0, 0, 0.95)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "1rem",
        color: "#fafafa",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
      role="dialog"
      aria-modal="true"
      aria-label={state === "countdown" ? "Emergency countdown" : state === "sending" ? "Sending emergency" : state}
      onPointerDown={handleOverlayPointerDown}
      onTouchStart={handleOverlayTouchStart}
    >
      {renderCountdown()}
      {renderSending()}
      {renderSuccess()}
      {renderFailure()}
      {renderCancelled()}
    </div>
  );
}