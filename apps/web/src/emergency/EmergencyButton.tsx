/** Emergency Button (P6) — accessible large red button with triple-tap detection. */

import { useEffect, useRef, useCallback, useState } from "react";
import { useEmergencyContext } from "./EmergencyContext";
import { useDebugMode } from "./DebugStrip";

interface EmergencyButtonProps {
  contacts?: Array<{ id: string; name: string; telegramChatId: string }>;
  userName: string;
  disabled?: boolean;
  lang: "en" | "hi";
}

interface ParsedContactsResult {
  contacts: Array<{ id: string; name: string; telegramChatId: string }>;
  parseError?: string;
}

/**
 * Parse contacts from VITE_EMERGENCY_CONTACTS_JSON with error tracking for debug mode.
 */
function parseContactsWithError(): ParsedContactsResult {
  try {
    const raw = import.meta.env.VITE_EMERGENCY_CONTACTS_JSON;
    if (!raw) return { contacts: [] };
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { contacts: [] };
    const valid = parsed.filter(
      (c): c is { id: string; name: string; telegramChatId: string } =>
        typeof c === "object" &&
        c !== null &&
        typeof c.id === "string" &&
        typeof c.name === "string" &&
        typeof c.telegramChatId === "string" &&
        c.id.length > 0 &&
        c.name.trim().length > 0 &&
        /^-?\d+$/.test(c.telegramChatId)
    );
    return { contacts: valid };
  } catch (err) {
    return { contacts: [], parseError: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Large accessible emergency button.
 * - Full-width on mobile, high contrast red
 * - ARIA label for screen readers
 * - Shows contact count
 * - Triple-tap detector on whole document (works offline)
 * - Keyboard accessible (Space/Enter)
 */
export function EmergencyButton({
  contacts,
  userName,
  disabled = false,
  lang,
}: EmergencyButtonProps) {
  const { trigger, state } = useEmergencyContext();
  const debugMode = useDebugMode();
  const tapCountRef = useRef(0);
  const tapTimerRef = useRef<number | null>(null);
  const lastTapTimeRef = useRef(0);
  const countdownStartRef = useRef<number | null>(null);
  const [isPressed, setIsPressed] = useState(false);

  // Track countdown start time to ignore taps for first 1.5s
  useEffect(() => {
    if (state === "countdown" && countdownStartRef.current === null) {
      countdownStartRef.current = Date.now();
    } else if (state !== "countdown") {
      countdownStartRef.current = null;
    }
  }, [state]);

  // Parse contacts with error for debug display
  const { contacts: parsedContacts, parseError } = parseContactsWithError();
  // Use env contacts only if contacts prop is not explicitly provided (undefined)
  // Empty array means explicitly no contacts
  const displayContacts = contacts !== undefined && contacts.length > 0 ? contacts : (contacts === undefined ? parsedContacts : []);

  // Handle triple-tap detection on whole document
  const handleGlobalClick = useCallback(
    (e: MouseEvent | TouchEvent) => {
      // Ignore ALL taps during countdown (overlay handles cancel)
      if (state === "countdown") {
        return;
      }

      // Ignore if clicking on interactive elements (buttons, links, inputs)
      const target = e.target as HTMLElement;
      const closest = target.closest?.bind(target);
      if (
        target.tagName === "BUTTON" ||
        target.tagName === "A" ||
        target.tagName === "INPUT" ||
        target.tagName === "SELECT" ||
        target.tagName === "TEXTAREA" ||
        closest?.("button") ||
        closest?.("a") ||
        closest?.("input")
      ) {
        return;
      }

      const now = Date.now();
      // Reset tap count if more than 500ms since last tap
      if (now - lastTapTimeRef.current > 500) {
        tapCountRef.current = 0;
      }
      lastTapTimeRef.current = now;
      tapCountRef.current += 1;

      if (tapCountRef.current === 3) {
        // Triple-tap detected - trigger emergency
        tapCountRef.current = 0;
        if (!disabled) {
          trigger(displayContacts, userName);
        }
      } else {
        // Reset timer
        if (tapTimerRef.current) window.clearTimeout(tapTimerRef.current);
        tapTimerRef.current = window.setTimeout(() => {
          tapCountRef.current = 0;
        }, 500);
      }
    },
    [displayContacts, userName, disabled, trigger, state, debugMode]
  );

  // Set up global click listener for triple-tap
  useEffect(() => {
    document.addEventListener("click", handleGlobalClick, true);
    document.addEventListener("touchstart", handleGlobalClick, true);
    return () => {
      document.removeEventListener("click", handleGlobalClick, true);
      document.removeEventListener("touchstart", handleGlobalClick, true);
      if (tapTimerRef.current) window.clearTimeout(tapTimerRef.current);
    };
  }, [handleGlobalClick]);

  const handleClick = () => {
    if (disabled) return;
    trigger(displayContacts, userName);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      trigger(displayContacts, userName);
    }
  };

  const handleMouseDown = () => setIsPressed(true);
  const handleMouseUp = () => setIsPressed(false);
  const handleMouseLeave = () => setIsPressed(false);

  const idleLabel = lang === "hi" ? "सहायता के लिए ३ बार टैप करें" : "Tap 3 times for help";

  // Show "N contacts loaded" or "No contacts loaded" on idle button
  const contactText = displayContacts.length === 0
    ? "No contacts loaded"
    : `${displayContacts.length} contact${displayContacts.length === 1 ? "" : "s"} loaded`;

  const ariaLabel = displayContacts.length === 0
    ? "SOS — No contacts loaded"
    : `SOS — ${idleLabel} — ${contactText}`;

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onTouchStart={handleMouseDown}
        onTouchEnd={handleMouseUp}
        onTouchCancel={handleMouseLeave}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-live="polite"
        style={{
          width: "100%",
          maxWidth: "100%",
          padding: "1.5rem 1rem",
          fontSize: "clamp(1rem, 3vw, 1.3rem)",
          fontWeight: "bold",
          borderRadius: "12px",
          border: "none",
          background: disabled ? "#4b0000" : isPressed ? "#991b1b" : "#dc2626",
          color: "white",
          cursor: disabled ? "not-allowed" : "pointer",
          boxShadow: isPressed ? "inset 0 2px 4px rgba(0,0,0,0.3)" : "0 4px 6px rgba(220, 38, 38, 0.3)",
          transition: "background 0.1s, transform 0.05s",
          transform: isPressed ? "scale(0.98)" : "scale(1)",
          opacity: disabled ? 0.6 : 1,
          touchAction: "manipulation",
          boxSizing: "border-box",
          wordWrap: "break-word",
          whiteSpace: "normal",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem", textAlign: "center" }}>
          <span>SOS</span>
          <span style={{ fontSize: "clamp(0.85rem, 2.5vw, 1rem)", opacity: 0.95, fontWeight: "normal" }}>
            {displayContacts.length > 0 ? idleLabel : contactText}
          </span>
          {displayContacts.length > 0 && (
            <span style={{ fontSize: "clamp(0.75rem, 2vw, 0.9rem)", opacity: 0.85, fontWeight: "normal" }}>
              {contactText}
            </span>
          )}
        </div>
      </button>
      {/* Debug info for contacts parsing */}
      {debugMode && parseError && (
        <div style={{ marginTop: "0.5rem", padding: "0.5rem", background: "rgba(239,68,68,0.1)", border: "1px solid #ef4444", borderRadius: "6px", fontSize: "0.7rem", color: "#fca5a5", fontFamily: "monospace", maxWidth: "640px" }}>
          <strong>Contacts parse error:</strong> {parseError}<br/>
          <strong>Source:</strong> VITE_EMERGENCY_CONTACTS_JSON (from .env or build env)
        </div>
      )}
    </>
  );
}