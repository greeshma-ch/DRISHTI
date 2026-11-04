/** Emergency State Machine (P6) — pure TypeScript, no network in countdown. */

import { useState, useEffect, useCallback, useRef } from "react";
import { getSystemMessage } from "../phrases";

export interface EmergencyEvent {
  timestamp: number;
  type: "state" | "request" | "response" | "error" | "speech";
  state?: EmergencyState;
  url?: string;
  method?: string;
  status?: number;
  error?: string;
  message?: string;
}

export type EmergencyState =
  | "idle"
  | "countdown"
  | "sending"
  | "success"
  | "failure"
  | "cancelled";

export interface EmergencyContext {
  state: EmergencyState;
  countdown: number; // 10..0 during countdown
  error?: string;
  contactName?: string; // first contact name for failure fallback
  httpStatus?: number; // HTTP status from emergency request
  lastRequestUrl?: string;
  lastError?: string;
  eventLog: EmergencyEvent[];
}

export interface EmergencyActions {
  trigger: (contacts: Array<{ id: string; name: string; telegramChatId: string }>, userName: string) => void;
  cancel: () => void;
  onSendResult: (success: boolean, httpStatus?: number, error?: string) => void;
  reset: () => void;
  setRecentAlerts: (alerts: string[]) => void;
  clearEventLog: () => void;
}

export interface UseEmergencyResult extends EmergencyContext, EmergencyActions {}

/**
 * Soft beep using Web Audio API (offline-capable).
 * Plays a brief sine wave tone.
 */
function playSoftBeep(): void {
  if (typeof window === "undefined" || !window.AudioContext) return;
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = 880; // A5
    gain.gain.value = 0.1;
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start();
    oscillator.stop(ctx.currentTime + 0.1);
  } catch {
    // Silently ignore audio errors
  }
}

/**
 * Hook for emergency state machine.
 * State transitions:
 * - idle -> countdown (10s, speaks instruction once, beeps each second, speaks 3-2-1)
 * - countdown -> cancelled (tap/voice cancel)
 * - countdown -> sending (after countdown reaches 0)
 * - sending -> success (server returns ok)
 * - sending -> failure (server returns error or network fails)
 * - success/failure -> idle (on reset)
 */
export function useEmergency(
  lang: "en" | "hi" = "en",
  onEmergencySend?: (contacts: string[], userName: string, recentAlerts: string[], authToken?: { user_id: string; token: string } | null) => Promise<{ ok: boolean; contactName?: string; httpStatus?: number; error?: string }>,
  getAuthToken?: () => Promise<{ user_id: string; token: string } | null>
): UseEmergencyResult {
  const [state, setState] = useState<EmergencyState>("idle");
  const [countdown, setCountdown] = useState(10);
  const [error, setError] = useState<string | undefined>();
  const [contactName, setContactName] = useState<string | undefined>();
  const [httpStatus, setHttpStatus] = useState<number | undefined>();
  const [lastRequestUrl, setLastRequestUrl] = useState<string | undefined>();
  const [lastError, setLastError] = useState<string | undefined>();
  const [eventLog, setEventLog] = useState<EmergencyEvent[]>([]);

  const countdownTimerRef = useRef<number | null>(null);
  const pendingContactsRef = useRef<Array<{ id: string; name: string; telegramChatId: string }>>([]);
  const pendingUserNameRef = useRef("");
  const recentAlertsRef = useRef<string[]>([]);
  const utteranceGenRef = useRef(0);
  const authTokenRef = useRef<{ user_id: string; token: string } | null>(null);
  const sendTimeoutRef = useRef<number | null>(null);

  // Add event to log (keep last 50)
  const addEvent = useCallback((event: EmergencyEvent) => {
    setEventLog((prev) => [...prev, event].slice(-50));
  }, []);

  // Clear event log
  const clearEventLog = useCallback(() => {
    setEventLog([]);
  }, []);

  // Speak a phrase using SpeechSynthesis
  const speak = useCallback(
    (text: string) => {
      if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
      const thisGen = ++utteranceGenRef.current;
      window.speechSynthesis.cancel(); // Interrupt any current speech
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = lang === "hi" ? "hi-IN" : "en-IN";
      utterance.onend = () => {
        if (utteranceGenRef.current !== thisGen) return;
        // Speech finished
      };
      utterance.onerror = () => {
        if (utteranceGenRef.current !== thisGen) return;
        // Speech error
      };
      window.speechSynthesis.speak(utterance);
      addEvent({ timestamp: Date.now(), type: "speech", message: text });
    },
    [lang, addEvent]
  );

  // Clear any running countdown timer
  const clearTimer = useCallback(() => {
    if (countdownTimerRef.current !== null) {
      window.clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    if (sendTimeoutRef.current !== null) {
      window.clearTimeout(sendTimeoutRef.current);
      sendTimeoutRef.current = null;
    }
  }, []);

  // Start the 10-second countdown
  const startCountdown = useCallback(() => {
    setCountdown(10);
    setState("countdown");
    setError(undefined);
    setHttpStatus(undefined);
    setLastError(undefined);
    addEvent({ timestamp: Date.now(), type: "state", state: "countdown" });

    // Speak countdown instruction once
    const instruction = getSystemMessage("emergency_countdown_instruction", lang);
    if (instruction) speak(instruction);

    // Start timer: tick every second
    countdownTimerRef.current = window.setInterval(() => {
      setCountdown((prev) => {
        const next = prev - 1;
        if (next < 0) return 0;

        // Play soft beep each second
        playSoftBeep();

        // Speak 3, 2, 1 at the end
        if (next === 3) {
          speak(getSystemMessage("emergency_countdown_3", lang));
        } else if (next === 2) {
          speak(getSystemMessage("emergency_countdown_2", lang));
        } else if (next === 1) {
          speak(getSystemMessage("emergency_countdown_1", lang));
        } else if (next === 0) {
          // Countdown complete - transition to sending
          clearTimer();
          setState("sending");
          addEvent({ timestamp: Date.now(), type: "state", state: "sending" });
          // No contacts means no Telegram request; show the local fallback screen.
          if (pendingContactsRef.current.length === 0) {
            setContactName(undefined);
            setState("failure");
            addEvent({ timestamp: Date.now(), type: "state", state: "failure", error: "No contacts configured" });
            return next;
          }
          if (onEmergencySend) {
            const url = "/emergency";
            setLastRequestUrl(url);
            addEvent({ timestamp: Date.now(), type: "request", url, method: "POST" });
            // Set send timeout (30s max)
            sendTimeoutRef.current = window.setTimeout(() => {
              if (state === "sending") {
                setHttpStatus(0);
                setLastError("Request timeout");
                addEvent({ timestamp: Date.now(), type: "error", status: 0, error: "Request timeout" });
                onSendResult(false, 0, "Request timeout");
              }
            }, 30000);
            onEmergencySend(
              pendingContactsRef.current.map((c) => c.telegramChatId),
              pendingUserNameRef.current,
              recentAlertsRef.current,
              authTokenRef.current
            ).then((result) => {
              // Clear send timeout
              if (sendTimeoutRef.current !== null) {
                window.clearTimeout(sendTimeoutRef.current);
                sendTimeoutRef.current = null;
              }
              // Store HTTP status and error for display
              if (result.httpStatus !== undefined) setHttpStatus(result.httpStatus);
              if (result.error) setLastError(result.error);
              // Call onSendResult for demo page simulation
              onSendResult(result.ok, result.httpStatus, result.error);
            }).catch((err) => {
              if (sendTimeoutRef.current !== null) {
                window.clearTimeout(sendTimeoutRef.current);
                sendTimeoutRef.current = null;
              }
              setHttpStatus(0);
              setLastError(err.message);
              addEvent({ timestamp: Date.now(), type: "error", status: 0, error: err.message });
              onSendResult(false, 0, err.message);
            });
          }
        }
        return next;
      });
    }, 1000);
  }, [lang, speak, clearTimer, onEmergencySend, addEvent]);

  // Trigger emergency flow
  const trigger = useCallback(
    async (contacts: Array<{ id: string; name: string; telegramChatId: string }>, userName: string) => {
      if (state !== "idle") return; // Already in progress
      pendingContactsRef.current = contacts;
      pendingUserNameRef.current = userName;
      // recentAlerts should be set externally before trigger

      // Fetch auth token before starting countdown
      if (getAuthToken) {
        try {
          const auth = await getAuthToken();
          if (auth) {
            authTokenRef.current = auth;
          }
        } catch {
          // Auth failed, will fail at send time
        }
      }
      startCountdown();
    },
    [state, startCountdown, getAuthToken]
  );

  // Cancel countdown (tap or voice)
  const cancel = useCallback(() => {
    if (state !== "countdown") return;
    clearTimer();
    setState("idle");
    setCountdown(10);
    addEvent({ timestamp: Date.now(), type: "state", state: "idle" });
    const cancelledMsg = getSystemMessage("emergency_cancelled", lang);
    if (cancelledMsg) speak(cancelledMsg);
  }, [state, lang, speak, clearTimer, addEvent]);

  // Called when server responds to emergency send
  const onSendResult = useCallback((success: boolean, httpStatus?: number, error?: string) => {
    if (state !== "sending") return;
    if (httpStatus !== undefined) setHttpStatus(httpStatus);
    if (error) setLastError(error);
    if (success) {
      setState("success");
      addEvent({ timestamp: Date.now(), type: "response", status: httpStatus });
      const sentMsg = getSystemMessage("emergency_sent", lang);
      if (sentMsg) speak(sentMsg);
    } else {
      setState("failure");
      addEvent({ timestamp: Date.now(), type: "error", status: httpStatus, error });
      const failedMsg = getSystemMessage("emergency_failed", lang)?.replace("{name}", contactName || "contact");
      if (failedMsg) speak(failedMsg);
    }
  }, [state, lang, speak, contactName, addEvent]);

  // Reset to idle (e.g., after success/failure screen dismissed)
  const reset = useCallback(() => {
    clearTimer();
    setState("idle");
    setCountdown(10);
    setError(undefined);
    setContactName(undefined);
    setHttpStatus(undefined);
    setLastRequestUrl(undefined);
    setLastError(undefined);
    addEvent({ timestamp: Date.now(), type: "state", state: "idle" });
  }, [clearTimer, addEvent]);

  // Update recent alerts from external source (e.g., MainApp)
  const setRecentAlerts = useCallback((alerts: string[]) => {
    recentAlertsRef.current = alerts.slice(-3);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => clearTimer();
  }, [clearTimer]);

  return {
    state,
    countdown,
    error,
    contactName,
    httpStatus,
    lastRequestUrl,
    lastError,
    eventLog,
    trigger,
    cancel,
    onSendResult,
    reset,
    setRecentAlerts,
    clearEventLog,
  };
}