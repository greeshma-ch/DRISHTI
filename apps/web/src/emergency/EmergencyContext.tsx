/** Emergency Context (P6) — single provider for emergency state machine. */

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useEmergency, type EmergencyEvent, type EmergencyState } from "./EmergencyStateMachine";

interface EmergencyContextValue {
  // State
  state: EmergencyState;
  countdown: number;
  error?: string;
  contactName?: string;
  httpStatus?: number;
  lastRequestUrl?: string;
  lastError?: string;
  eventLog: EmergencyEvent[];
  // Actions
  trigger: (contacts: Array<{ id: string; name: string; telegramChatId: string }>, userName: string) => void;
  cancel: () => void;
  onSendResult: (success: boolean, httpStatus?: number, error?: string) => void;
  reset: () => void;
  setRecentAlerts: (alerts: string[]) => void;
  clearEventLog: () => void;
  // Instance ID for debugging
  instanceId: string;
  // Language for TTS
  lang: "en" | "hi";
  // GPS position for SMS prefill
  lastGpsPosition: { lat: number; lon: number; timestamp: number } | null;
  setLastGpsPosition: (pos: { lat: number; lon: number; timestamp: number } | null) => void;
}

const EmergencyContext = createContext<EmergencyContextValue | null>(null);

/**
 * Hook to access the single emergency state machine instance.
 * Must be used within EmergencyProvider.
 */
export function useEmergencyContext(): EmergencyContextValue {
  const ctx = useContext(EmergencyContext);
  if (!ctx) {
    throw new Error("useEmergencyContext must be used within EmergencyProvider");
  }
  return ctx;
}

/**
 * Optional version of useEmergencyContext that returns undefined if not in a provider.
 * Useful for components that can work with props OR context (like EmergencyScreen in tests).
 */
export function useEmergencyContextOptional(): EmergencyContextValue | null {
  return useContext(EmergencyContext);
}

interface EmergencyProviderProps {
  children: ReactNode;
  lang: "en" | "hi";
  onEmergencySend?: (contacts: string[], userName: string, recentAlerts: string[], auth?: { user_id: string; token: string } | null) => Promise<{ ok: boolean; contactName?: string; httpStatus?: number; error?: string }>;
  getAuthToken?: () => Promise<{ user_id: string; token: string } | null>;
}

/**
 * Single provider for the emergency state machine.
 * Creates exactly one instance of useEmergency and provides it via context.
 * Also handles GPS position caching for SMS prefill.
 */
export function EmergencyProvider({
  children,
  lang,
  onEmergencySend,
  getAuthToken,
}: EmergencyProviderProps) {
  // Generate a unique instance ID for debugging
  const instanceIdRef = useRef(`emg-${Math.random().toString(36).slice(2, 9)}`);
  const instanceId = instanceIdRef.current;

  const emergency = useEmergency(lang, onEmergencySend, getAuthToken);

  // GPS position for SMS prefill (cached from watchPosition)
  const [lastGpsPosition, setLastGpsPosition] = useState<{ lat: number; lon: number; timestamp: number } | null>(null);

  // Start watchPosition to cache GPS for SMS prefill
  useEffect(() => {
    if (typeof window === "undefined" || !navigator.geolocation) return;

    let watchId: number;
    try {
      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          setLastGpsPosition({
            lat: pos.coords.latitude,
            lon: pos.coords.longitude,
            timestamp: pos.timestamp,
          });
        },
        (err) => {
          // Silently ignore GPS errors - we'll use last known or none
          console.debug("[EmergencyProvider] GPS watch error:", err.message);
        },
        { enableHighAccuracy: false, timeout: 10000, maximumAge: 30000 }
      );
    } catch {
      // Geolocation may not be available/allowed
    }

    return () => {
      if (watchId !== undefined) {
        navigator.geolocation.clearWatch(watchId);
      }
    };
  }, []);

  return (
    <EmergencyContext.Provider
      value={{
        ...emergency,
        instanceId,
        lang,
        lastGpsPosition,
        setLastGpsPosition,
      }}
    >
      {children}
    </EmergencyContext.Provider>
  );
}

export { EmergencyContext };