/** Voice Help Hook (P6) — SpeechRecognition for "help"/"मदद" and "cancel"/"रुको". */

import { useEffect, useRef, useCallback, useState } from "react";

// TypeScript declarations for SpeechRecognition (not in standard lib)
interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

interface SpeechRecognitionResultList {
  length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
  isFinal: boolean;
}

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface SpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: (event: SpeechRecognitionEvent) => void;
  onerror: (event: SpeechRecognitionErrorEvent) => void;
  onend: () => void;
  onstart: () => void;
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
  message: string;
}

// Augment global Window interface
declare global {
  interface Window {
    SpeechRecognition: new () => SpeechRecognition;
    webkitSpeechRecognition: new () => SpeechRecognition;
  }
}

interface UseVoiceHelpProps {
  lang: "en" | "hi";
  onEmergencyTrigger: () => void;
  onEmergencyCancel: () => void;
  enabled?: boolean;
}

/**
 * Hook for voice-activated emergency.
 * Listens for "help"/"मदद" to trigger, "cancel"/"रुको" to cancel.
 * Only active when mic permission granted and enabled.
 * Best-effort: Chrome SpeechRecognition requires network.
 */
export function useVoiceHelp({
  lang,
  onEmergencyTrigger,
  onEmergencyCancel,
  enabled = true,
}: UseVoiceHelpProps) {
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const [isListening, setIsListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const restartTimeoutRef = useRef<number | null>(null);
  const isShuttingDownRef = useRef(false);

  // Check if SpeechRecognition is available
  const isSupported =
    typeof window !== "undefined" &&
    ("SpeechRecognition" in window || "webkitSpeechRecognition" in window);

  const getKeywords = useCallback(() => {
    if (lang === "hi") {
      return {
        trigger: ["मदद", "हेल्प", "help", "बचाओ"],
        cancel: ["रुको", "कैंसल", "cancel", "रोक दो"],
      };
    }
    return {
      trigger: ["help", "emergency", "help me"],
      cancel: ["cancel", "stop", "never mind"],
    };
  }, [lang]);

  const startRecognition = useCallback(() => {
    if (!isSupported || !enabled || isShuttingDownRef.current) return;

    const SpeechRecognitionCtor = (window.SpeechRecognition || window.webkitSpeechRecognition) as new () => SpeechRecognition;
    const recognition = new SpeechRecognitionCtor();
    recognition.lang = lang === "hi" ? "hi-IN" : "en-IN";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (!result || !result.isFinal) continue;
        const transcript = result[0]?.transcript.toLowerCase().trim();
        if (!transcript) continue;
        const keywords = getKeywords();

        // Check for trigger words
        if (keywords.trigger.some((kw) => transcript.includes(kw))) {
          onEmergencyTrigger();
          return;
        }

        // Check for cancel words
        if (keywords.cancel.some((kw) => transcript.includes(kw))) {
          onEmergencyCancel();
          return;
        }
      }
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      // Ignore common non-fatal errors
      if (event.error === "no-speech" || event.error === "audio-capture") return;
      if (event.error === "not-allowed") {
        setError("Microphone permission denied");
        setIsListening(false);
        return;
      }
      if (event.error === "network") {
        // Network error - SpeechRecognition needs network in Chrome
        setError("Voice recognition needs internet");
        // Try to restart after a delay
        if (restartTimeoutRef.current) window.clearTimeout(restartTimeoutRef.current);
        restartTimeoutRef.current = window.setTimeout(() => {
          if (!isShuttingDownRef.current) startRecognition();
        }, 5000);
        return;
      }
      console.warn("[VoiceHelp] SpeechRecognition error:", event.error);
    };

    recognition.onend = () => {
      if (isShuttingDownRef.current) return;
      // Auto-restart if still enabled
      if (enabled && isSupported) {
        if (restartTimeoutRef.current) window.clearTimeout(restartTimeoutRef.current);
        restartTimeoutRef.current = window.setTimeout(() => {
          if (!isShuttingDownRef.current && enabled) startRecognition();
        }, 100);
      } else {
        setIsListening(false);
      }
    };

    try {
      recognition.start();
      setIsListening(true);
      setError(null);
      recognitionRef.current = recognition;
    } catch (err) {
      console.warn("[VoiceHelp] Failed to start recognition:", err);
      setError("Failed to start voice recognition");
    }
  }, [enabled, isSupported, lang, getKeywords, onEmergencyTrigger, onEmergencyCancel]);

  const stopRecognition = useCallback(() => {
    isShuttingDownRef.current = true;
    if (restartTimeoutRef.current) {
      window.clearTimeout(restartTimeoutRef.current);
      restartTimeoutRef.current = null;
    }
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // Ignore
      }
      recognitionRef.current = null;
    }
    setIsListening(false);
  }, []);

  // Start/stop based on enabled prop
  useEffect(() => {
    if (enabled && isSupported) {
      startRecognition();
    } else {
      stopRecognition();
    }
    return () => {
      isShuttingDownRef.current = true;
      stopRecognition();
    };
  }, [enabled, isSupported, startRecognition, stopRecognition]);

  return {
    isListening,
    error,
    isSupported,
    start: startRecognition,
    stop: stopRecognition,
  };
}