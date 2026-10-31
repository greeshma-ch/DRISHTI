import { useState, useRef, useEffect, useCallback } from "react";
import { buildPhrase } from "./phrases";
import {
  PriorityArbiter,
  makeHazardMessage,
  makeAdvisoryMessage,
  makeVisionPausedMessage,
  makeVisionBackMessage,
  makeVisionLimitedMessage,
  makeEmergencyMessage,
  makeNavMessage,
  type ArbiterMessage,
} from "./arbiter";
import { playClipOrTTS, stopClip, playSoftTick } from "./audio";

interface HazardItem {
  type: string;
  direction: string;
  distance: string;
  clear_side?: "left" | "right" | "none" | string;
  label?: string | null;
  urgency: number;
  confidence?: number;
}

interface FrameUsage {
  input_tokens?: number;
  output_tokens?: number;
  est_cost_usd?: number;
}

interface PerceptionResponse {
  perception: {
    hazard?: HazardItem | null;
    hazards: HazardItem[];
    path_clear: boolean;
    instruction: string;
    signage_text?: string[];
  };
  usage: FrameUsage & { finish_reason?: string };
  latency_ms: number;
  client_timestamp: number;
  server_total_ms?: number;
  meta_ms?: number;
  finish_reason?: string;
}

interface FrameDurations {
  captureToResponse: number;
  network: number;
  serverTotal: number;
  meta: number;
  responseToSpeechStart: number | string | null;
  jpegKb: number;
}

interface VoiceStatus {
  ready: boolean;
  timeMs: number;
  warning: string | null;
}

const API_BASE = import.meta.env.VITE_API_BASE || "/api";



const waitForVoices = (timeoutMs = 5000): Promise<SpeechSynthesisVoice[]> => {
  return new Promise((resolve) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      resolve([]);
      return;
    }
    const existing = window.speechSynthesis.getVoices();
    if (existing.length > 0) {
      resolve(existing);
      return;
    }
    let timer: number | null = null;
    const onVoices = () => {
      if (timer) clearTimeout(timer);
      window.speechSynthesis.removeEventListener("voiceschanged", onVoices);
      resolve(window.speechSynthesis.getVoices());
    };
    window.speechSynthesis.addEventListener("voiceschanged", onVoices);
    timer = window.setTimeout(() => {
      window.speechSynthesis.removeEventListener("voiceschanged", onVoices);
      resolve(window.speechSynthesis.getVoices());
    }, timeoutMs);
  });
};

function MainApp() {
  const [isRunning, setIsRunning] = useState(false);
  const [lang, setLang] = useState<"en" | "hi">(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("drishti-lang");
      if (saved === "en" || saved === "hi") return saved;
    }
    return "en";
  });
  const [statusMsg, setStatusMsg] = useState("Ready");
  const [lastLatency, setLastLatency] = useState<number | null>(null);
  const [finishReason, setFinishReason] = useState<string>("--");
  const [inputTokens, setInputTokens] = useState<number>(0);
  const [outputTokens, setOutputTokens] = useState<number>(0);
  const [estCost, setEstCost] = useState<number>(0);
  const [sessionCost, setSessionCost] = useState<number>(0);
  const [lastSpoken, setLastSpoken] = useState<string>("None");
  const [inFlight, setInFlight] = useState<number>(0);
  const [jpegKb, setJpegKb] = useState<number>(0);
  const [queuedUtterances, setQueuedUtterances] = useState<number>(0);
  const [staleThresholdSec] = useState<number>(8); // Configurable threshold, default 8s
  const [staleDroppedCount, setStaleDroppedCount] = useState<number>(0);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus | null>(null);
  const [durations, setDurations] = useState<FrameDurations | null>(null);
  const [softTickEnabled, setSoftTickEnabled] = useState(true); // Soft tick every 8s

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const inFlightRef = useRef<number>(0);
  const isPendingPreviousRef = useRef<boolean>(false);
  const intervalIdRef = useRef<number | null>(null);
  const hiVoiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const enVoiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const arbiterRef = useRef<PriorityArbiter | null>(null);
  const currentDurationsRef = useRef<FrameDurations | null>(null);

  // Vision watchdog state
  const consecutiveFailuresRef = useRef<number>(0);
  const isVisionDegradedRef = useRef<boolean>(false);
  const visionLimitedIntervalRef = useRef<number | null>(null);
  const lastVisionBackRef = useRef<number>(0);

  // Utterance generation counter — prevents stale onend/onerror from clearing state
  const utteranceGenRef = useRef<number>(0);

  // Sync language to localStorage for shared state across pages
  useEffect(() => {
    localStorage.setItem("drishti-lang", lang);
  }, [lang]);

  const getUtterancesQueued = useCallback(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return 0;
    return (window.speechSynthesis.pending ? 1 : 0) + (window.speechSynthesis.speaking ? 1 : 0);
  }, []);

  // Infer priority from message key (matches arbiter.stateful.test.ts logic)
  const inferPriorityFromKey = useCallback((key: string): 0 | 1 | 2 | 3 => {
    if (key === "emergency") return 0;
    if (key.startsWith("hazard:") || key.startsWith("status:")) return 1;
    if (key.startsWith("nav:")) return 2;
    if (key.startsWith("adv:")) return 3;
    return 3;
  }, []);

  // Arbiter speak callback - called by PriorityArbiter when it wants to speak
  const arbiterSpeak = useCallback(
    (
      text: string,
      language: "en" | "hi",
      key: string,
      responseReceivedPerfMs?: number,
      clipKey?: string,
      clipType?: "hazards" | "system"
    ) => {
      if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
      if (!text || text === "unknown") return;

      const priority = inferPriorityFromKey(key);

      // Bump generation: any pending handlers from the old utterance are now stale
      const thisGen = ++utteranceGenRef.current;

      // Shared start/end handlers for both clip and TTS
      const onSpeechStart = () => {
        // Ignore if this utterance has been superseded
        if (utteranceGenRef.current !== thisGen) return;
        if (currentDurationsRef.current && responseReceivedPerfMs) {
          const speechStartDelay = Math.round(performance.now() - responseReceivedPerfMs);
          currentDurationsRef.current.responseToSpeechStart = speechStartDelay;
          setDurations({ ...currentDurationsRef.current });
        }
        setQueuedUtterances(getUtterancesQueued());
        arbiterRef.current?.onSpeechStart(priority);
      };
      const onSpeechEnd = () => {
        // Ignore if this utterance has been superseded
        if (utteranceGenRef.current !== thisGen) return;
        setQueuedUtterances(getUtterancesQueued());
        arbiterRef.current?.onSpeechEnd();
      };

      // Try pre-rendered audio clip first, fall back to TTS
      const ttsFallback = (fallbackText: string, fallbackLang: "en" | "hi") => {
        const utterance = new SpeechSynthesisUtterance(fallbackText);
        utterance.lang = fallbackLang === "hi" && hiVoiceRef.current ? "hi-IN" : "en-IN";
        const selectedVoice = fallbackLang === "hi" ? hiVoiceRef.current || enVoiceRef.current : enVoiceRef.current;
        if (selectedVoice) {
          utterance.voice = selectedVoice;
        }

        utterance.onstart = onSpeechStart;
        utterance.onend = onSpeechEnd;
        utterance.onerror = onSpeechEnd;

        window.speechSynthesis.speak(utterance);
        setLastSpoken(fallbackText);
        setQueuedUtterances(getUtterancesQueued());
      };

      // Use pre-rendered clip if available, otherwise TTS
      if (clipKey && clipType) {
        playClipOrTTS(text, language, clipKey, clipType, ttsFallback, onSpeechStart, onSpeechEnd);
      } else {
        ttsFallback(text, language);
      }
    },
    [getUtterancesQueued, inferPriorityFromKey]
  );

  // Arbiter cancel callback - called by PriorityArbiter to interrupt
  // For P0/P1, wait ~50ms after cancel to let old utterance's onend/onerror fire
  const arbiterCancel = useCallback(
    async (priority?: number) => {
      if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
      window.speechSynthesis.cancel();
      stopClip();
      // Bump generation so any late onend/onerror from the cancelled utterance is ignored
      utteranceGenRef.current += 1;
      // For P0/P1, wait ~50ms to let stale events drain before next speak
      if (priority !== undefined && priority <= 1) {
        await new Promise((r) => setTimeout(r, 50));
      }
      arbiterRef.current?.onSpeechEnd(); // Reset arbiter state
    },
    []
  );

  const captureAndSendFrame = useCallback(async () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < 2) return;

    if (inFlightRef.current >= 2 || isPendingPreviousRef.current) {
      return;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.drawImage(video, 0, 0, 640, 360);
    const capturePerfMs = performance.now();
    const clientTimestamp = Date.now() / 1000;

    canvas.toBlob(
      async (blob) => {
        if (!blob) return;

        isPendingPreviousRef.current = true;
        inFlightRef.current += 1;
        setInFlight(inFlightRef.current);

        const currentJpegKb = Number((blob.size / 1024).toFixed(1));
        setJpegKb(currentJpegKb);

        const formData = new FormData();
        formData.append("file", blob, "frame.jpg");
        formData.append("timestamp", clientTimestamp.toString());
        formData.append("lang", lang);

        const reqSentPerfMs = performance.now();

        try {
          const resp = await fetch(`${API_BASE}/frame`, {
            method: "POST",
            body: formData,
          });

          if (!resp.ok) {
            throw new Error(`HTTP ${resp.status}`);
          }

          const respReceivedPerfMs = performance.now();
          const data: PerceptionResponse = await resp.json();

          const roundTrip = Math.round(respReceivedPerfMs - reqSentPerfMs);
          const serverTotal = data.server_total_ms ?? 0;
          const network = Math.max(0, Math.round(roundTrip - serverTotal));
          const captureToResponse = Math.round(respReceivedPerfMs - capturePerfMs);

          const currentDurations: FrameDurations = {
            captureToResponse,
            network,
            serverTotal,
            meta: data.meta_ms ?? 0,
            responseToSpeechStart: null,
            jpegKb: currentJpegKb,
          };
          setDurations(currentDurations);

          const ageSec = Date.now() / 1000 - data.client_timestamp;

          // 1. Drop if older than configured stale threshold (default 8s)
          if (ageSec > staleThresholdSec) {
            setStaleDroppedCount((c) => c + 1);
            setStatusMsg(`Dropped stale frame (> ${staleThresholdSec}s)`);
            currentDurations.responseToSpeechStart = `skipped (>${staleThresholdSec}s)`;
            setDurations({ ...currentDurations });
            return;
          }

          setLastLatency(data.latency_ms);
          setFinishReason(data.finish_reason || data.usage?.finish_reason || "stop");
          const inT = data.usage?.input_tokens ?? 0;
          const outT = data.usage?.output_tokens ?? 0;
          const cost = data.usage?.est_cost_usd ?? 0;

          setInputTokens(inT);
          setOutputTokens(outT);
          setEstCost(cost);
          setSessionCost((prev) => +(prev + cost).toFixed(6));
          setStatusMsg("Active");

          // Vision watchdog: recovery from degraded mode
          if (consecutiveFailuresRef.current >= 3 && isVisionDegradedRef.current) {
            isVisionDegradedRef.current = false;
            consecutiveFailuresRef.current = 0;

            // Clear periodic "Vision limited" interval
            if (visionLimitedIntervalRef.current) {
              clearInterval(visionLimitedIntervalRef.current);
              visionLimitedIntervalRef.current = null;
            }

            // Announce "Vision back" (debounced: not more than once per 10s)
            const now = Date.now();
            if (now - lastVisionBackRef.current > 10000) {
              lastVisionBackRef.current = now;
              const backMsg = makeVisionBackMessage(lang);
              arbiterRef.current?.enqueue(backMsg);
            }
          } else if (consecutiveFailuresRef.current > 0) {
            // Reset failure counter on any successful response
            consecutiveFailuresRef.current = 0;
          }

          // Announce Vision limited if 3 consecutive failures reached
          if (data.perception?.instruction === "Vision limited") {
            const visionLimitedMsg = makeAdvisoryMessage(
              lang === "hi" ? "दृष्टि सीमित" : "Vision limited",
              lang,
              "vision_limited"
            );
            arbiterRef.current?.enqueue(visionLimitedMsg);
            return;
          }

          // Extract single most urgent hazard
          const urgentHazard =
            data.perception?.hazard ||
            (data.perception?.hazards && data.perception.hazards.length > 0
              ? data.perception.hazards[0]
              : null);

          // Hard Rule 1: when valid result has no hazards, speak nothing!
          if (!urgentHazard) {
            currentDurations.responseToSpeechStart = "none (no hazard)";
            setDurations({ ...currentDurations });
            return;
          }

          // 2. Result older than 3s is spoken ONLY for hazards with distance "near" or "mid"
          if (ageSec > 3.0) {
            const dist = urgentHazard?.distance;
            if (dist !== "near" && dist !== "mid") {
              currentDurations.responseToSpeechStart = "skipped (>3s far)";
              setDurations({ ...currentDurations });
              return;
            }
          }

          // Build phrase using phrase table
          const phrase = buildPhrase(urgentHazard, lang);
          if (phrase) {
            // Store durations for arbiter callback
            currentDurationsRef.current = currentDurations;

            // Enqueue through priority arbiter
            const urgency = urgentHazard.urgency ?? 0;
            const confidence = urgentHazard.confidence ?? 0;
            const hazardMsg = makeHazardMessage(
              urgentHazard.type,
              urgentHazard.direction,
              phrase,
              lang,
              urgency,
              confidence,
              respReceivedPerfMs,
              urgentHazard.clear_side
            );
            arbiterRef.current?.enqueue(hazardMsg);
          }
        } catch (err) {
          // Track consecutive failures for vision watchdog
          consecutiveFailuresRef.current += 1;
          setStatusMsg(`Request error (${consecutiveFailuresRef.current}/3): ${err instanceof Error ? err.message : String(err)}`);

          // After 3 consecutive failures: Vision paused
          if (consecutiveFailuresRef.current === 3 && !isVisionDegradedRef.current) {
            isVisionDegradedRef.current = true;
            const pausedMsg = makeVisionPausedMessage(lang);
            arbiterRef.current?.enqueue(pausedMsg);

            // Start periodic "Vision limited" announcements every 15s
            visionLimitedIntervalRef.current = window.setInterval(() => {
              if (isVisionDegradedRef.current) {
                const limitedMsg = makeVisionLimitedMessage(lang);
                arbiterRef.current?.enqueue(limitedMsg);
              }
            }, 15000);
          }
        } finally {
          isPendingPreviousRef.current = false;
          inFlightRef.current = Math.max(0, inFlightRef.current - 1);
          setInFlight(inFlightRef.current);
          setQueuedUtterances(getUtterancesQueued());
        }
      },
      "image/jpeg",
      0.7
    );
  }, [lang, getUtterancesQueued, staleThresholdSec]);

  const startVision = async () => {
    try {
      const voiceStart = performance.now();
      setStatusMsg("Warming up voice...");

      const voices = await waitForVoices(5000);
      const hiVoice =
        voices.find(
          (v) =>
            v.lang.toLowerCase().startsWith("hi") ||
            v.lang.toLowerCase().replace("_", "-") === "hi-in"
        ) || null;
      const enVoice =
        voices.find(
          (v) =>
            v.lang.toLowerCase().startsWith("en") ||
            v.lang.toLowerCase().replace("_", "-") === "en-in"
        ) ||
        voices[0] ||
        null;

      hiVoiceRef.current = hiVoice;
      enVoiceRef.current = enVoice;

      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
        const warmUtterance = new SpeechSynthesisUtterance(" ");
        warmUtterance.volume = 0.01;
        if (enVoice) warmUtterance.voice = enVoice;
        window.speechSynthesis.speak(warmUtterance);
      }

      const voiceReadyMs = Math.round(performance.now() - voiceStart);
      setVoiceStatus({
        ready: true,
        timeMs: voiceReadyMs,
        warning: hiVoice ? null : "hi-IN voice missing; falling back to en-IN",
      });

      // Initialize priority arbiter
      arbiterRef.current = new PriorityArbiter(arbiterSpeak, arbiterCancel);

      setStatusMsg("Starting camera...");
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 640 },
          height: { ideal: 360 },
        },
        audio: false,
      });

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      // Warm-up frame
      setStatusMsg("Warming up connection...");
      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.fillStyle = "#000000";
          ctx.fillRect(0, 0, 640, 360);
          const warmBlob = await new Promise<Blob | null>((resolve) =>
            canvas.toBlob(resolve, "image/jpeg", 0.5)
          );
          if (warmBlob) {
            const warmForm = new FormData();
            warmForm.append("file", warmBlob, "warmup.jpg");
            warmForm.append("timestamp", (Date.now() / 1000).toString());
            warmForm.append("lang", lang);
            await fetch(`${API_BASE}/frame`, { method: "POST", body: warmForm }).catch(() => {});
          }
        }
      }

      setIsRunning(true);
      setStatusMsg("Vision running (0.5 fps)");
    } catch (err) {
      setStatusMsg(`Start error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const stopVision = () => {
    if (intervalIdRef.current) {
      clearInterval(intervalIdRef.current);
      intervalIdRef.current = null;
    }
    // Clear vision watchdog interval
    if (visionLimitedIntervalRef.current) {
      clearInterval(visionLimitedIntervalRef.current);
      visionLimitedIntervalRef.current = null;
    }
    if (videoRef.current && videoRef.current.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach((track) => track.stop());
      videoRef.current.srcObject = null;
    }
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    arbiterRef.current?.clear();
    arbiterRef.current = null;
    // Reset vision watchdog state
    consecutiveFailuresRef.current = 0;
    isVisionDegradedRef.current = false;
    lastVisionBackRef.current = 0;
    setIsRunning(false);
    setStatusMsg("Stopped");
    setInFlight(0);
    inFlightRef.current = 0;
    isPendingPreviousRef.current = false;
    setQueuedUtterances(0);
  };

  useEffect(() => {
    if (isRunning) {
      intervalIdRef.current = window.setInterval(captureAndSendFrame, 2000);
      return () => {
        if (intervalIdRef.current) {
          clearInterval(intervalIdRef.current);
          intervalIdRef.current = null;
        }
      };
    }
  }, [isRunning, captureAndSendFrame]);

  // Soft tick: play every 8s while running and enabled, but not while speaking
  useEffect(() => {
    if (!isRunning || !softTickEnabled) return;
    const timer = window.setInterval(() => {
      if (!window.speechSynthesis.speaking && !window.speechSynthesis.pending) {
        playSoftTick();
      }
    }, 8000);
    return () => clearInterval(timer);
  }, [isRunning, softTickEnabled]);

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
      <header style={{ width: "100%", maxWidth: "640px", marginBottom: "0.8rem", textAlign: "center" }}>
        <h1 style={{ margin: "0.2rem 0", fontSize: "1.8rem" }}>दृष्टि &middot; Drishti</h1>
        <p style={{ margin: 0, opacity: 0.7, fontSize: "0.9rem" }}>AI Walking Companion &mdash; P1 Skeleton</p>

        {voiceStatus && (
          <div
            style={{
              display: "inline-block",
              marginTop: "0.5rem",
              padding: "4px 10px",
              borderRadius: "12px",
              background: voiceStatus.warning ? "#854d0e" : "#166534",
              color: "#fef08a",
              fontSize: "0.8rem",
            }}
          >
            Voice ready ({voiceStatus.timeMs} ms)
            {voiceStatus.warning && <span> &mdash; {voiceStatus.warning}</span>}
          </div>
        )}
      </header>

      {/* Video & Hidden Canvas */}
      <div
        style={{
          position: "relative",
          width: "100%",
          maxWidth: "640px",
          aspectRatio: "16 / 9",
          background: "#181818",
          borderRadius: "8px",
          overflow: "hidden",
          border: isRunning ? "2px solid #22c55e" : "2px solid #3f3f46",
        }}
      >
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
        <canvas ref={canvasRef} width={640} height={360} style={{ display: "none" }} />

        <div
          style={{
            position: "absolute",
            top: "8px",
            left: "8px",
            background: "rgba(0,0,0,0.75)",
            padding: "4px 8px",
            borderRadius: "4px",
            fontSize: "0.8rem",
            color: isRunning ? "#4ade80" : "#a1a1aa",
          }}
        >
          ● {statusMsg}
        </div>
      </div>

      {/* Controls */}
      <section
        style={{
          width: "100%",
          maxWidth: "640px",
          marginTop: "1rem",
          display: "flex",
          gap: "0.5rem",
          alignItems: "center",
        }}
      >
        <button
          onClick={isRunning ? stopVision : startVision}
          style={{
            flex: 1,
            padding: "0.9rem",
            fontSize: "1.1rem",
            fontWeight: "bold",
            borderRadius: "8px",
            border: "none",
            background: isRunning ? "#dc2626" : "#2563eb",
            color: "white",
            cursor: "pointer",
          }}
        >
          {isRunning ? "Stop Vision" : "Start Vision"}
        </button>

        <button
          onClick={() => setLang((l) => (l === "en" ? "hi" : "en"))}
          style={{
            padding: "0.9rem 1.2rem",
            fontSize: "1rem",
            borderRadius: "8px",
            border: "1px solid #52525b",
            background: "#27272a",
            color: "#fafafa",
            cursor: "pointer",
          }}
        >
          Language: {lang === "en" ? "EN" : "हिन्दी"}
        </button>

        <button
          onClick={() => setSoftTickEnabled((e) => !e)}
          style={{
            padding: "0.9rem 1.2rem",
            fontSize: "1rem",
            borderRadius: "8px",
            border: "1px solid #52525b",
            background: softTickEnabled ? "#166534" : "#27272a",
            color: "#fafafa",
            cursor: "pointer",
            opacity: isRunning ? 1 : 0.5,
          }}
          disabled={!isRunning}
          title={isRunning ? "Toggle soft tick (every 8s)" : "Start vision to enable"}
        >
          Soft Tick: {softTickEnabled ? "ON" : "OFF"}
        </button>
      </section>

      {/* Debug Overlay */}
      <section
        aria-label="Debug Overlay"
        style={{
          width: "100%",
          maxWidth: "640px",
          marginTop: "1rem",
          background: "#18181b",
          border: "1px solid #27272a",
          borderRadius: "8px",
          padding: "0.8rem",
          boxSizing: "border-box",
          fontSize: "0.85rem",
        }}
      >
        <h2 style={{ fontSize: "0.95rem", margin: "0 0 0.5rem 0", color: "#a1a1aa" }}>Debug Overlay</h2>

        {/* Durations section */}
        <div style={{ marginBottom: "0.8rem", borderBottom: "1px solid #27272a", paddingBottom: "0.6rem" }}>
          <div style={{ fontWeight: "bold", color: "#38bdf8", marginBottom: "0.3rem" }}>
            Durations (ms):
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.25rem", fontSize: "0.8rem" }}>
            <div>
              Capture to Response:{" "}
              <strong>{durations ? `${durations.captureToResponse} ms` : "--"}</strong>
            </div>
            <div>
              Network (est):{" "}
              <strong>{durations ? `${durations.network} ms` : "--"}</strong>
            </div>
            <div>
              Server Total:{" "}
              <strong>{durations ? `${durations.serverTotal} ms` : "--"}</strong>
            </div>
            <div>
              Meta API:{" "}
              <strong>{durations ? `${durations.meta} ms` : "--"}</strong>
            </div>
            <div style={{ gridColumn: "span 2" }}>
              Response to Speech:{" "}
              <strong style={{ color: "#facc15" }}>
                {durations?.responseToSpeechStart !== null && durations?.responseToSpeechStart !== undefined
                  ? typeof durations.responseToSpeechStart === "number"
                    ? `${durations.responseToSpeechStart} ms`
                    : durations.responseToSpeechStart
                  : "--"}
              </strong>
            </div>
          </div>
        </div>

        {/* Payload & Queue metrics */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.4rem" }}>
          <div>
            Stale Threshold: <strong style={{ color: "#38bdf8" }}>{staleThresholdSec}s</strong>
          </div>
          <div>
            Dropped Stale: <strong style={{ color: "#ef4444" }}>{staleDroppedCount}</strong>
          </div>
          <div>
            JPEG Size: <strong style={{ color: "#facc15" }}>{jpegKb} KB</strong>
          </div>
          <div>
            Utterances Queued: <strong style={{ color: "#38bdf8" }}>{queuedUtterances}</strong>
          </div>
          <div>
            In-flight: <strong style={{ color: "#facc15" }}>{inFlight} / 2</strong>
          </div>
          <div>
            Latency:{" "}
            <strong style={{ color: "#38bdf8" }}>{lastLatency !== null ? `${lastLatency} ms` : "--"}</strong>
          </div>
          <div>
            Finish Reason:{" "}
            <strong style={{ color: finishReason === "length" ? "#ef4444" : "#38bdf8" }}>
              {finishReason}
            </strong>
          </div>
          <div>
            Output Tokens: <strong style={{ color: "#facc15" }}>{outputTokens}</strong>
          </div>
          <div>
            Tokens (In/Out):{" "}
            <strong>
              {inputTokens} / {outputTokens}
            </strong>
          </div>
          <div>
            Frame Cost: <strong style={{ color: "#4ade80" }}>${estCost.toFixed(4)}</strong>
          </div>
          <div>
            Session Cost: <strong style={{ color: "#4ade80" }}>${sessionCost.toFixed(4)}</strong>
          </div>
        </div>

        <div style={{ marginTop: "0.6rem", borderTop: "1px solid #27272a", paddingTop: "0.4rem" }}>
          Last Spoken (phrase table): <strong style={{ color: "#f43f5e" }}>"{lastSpoken}"</strong>
        </div>
      </section>
    </main>
  );
}

/** Demo page for testing priority arbiter with manual buttons */
function DemoPage() {
  // Use shared language state via localStorage for persistence across pages
  const [lang, setLang] = useState<"en" | "hi">(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("drishti-lang");
      if (saved === "en" || saved === "hi") return saved;
    }
    return "en";
  });
  const [queue, setQueue] = useState<string[]>([]);
  const [speaking, setSpeaking] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const arbiterRef = useRef<PriorityArbiter | null>(null);
  const hiVoiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const enVoiceRef = useRef<SpeechSynthesisVoice | null>(null);

  // Utterance generation counter — prevents stale onend/onerror from clearing state
  const utteranceGenRef = useRef<number>(0);

  // Logging helper - keeps last 30 lines
  const addLog = useCallback((msg: string) => {
    setLogs((prev) => {
      const next = [...prev, `[${Date.now() % 100000}] ${msg}`];
      return next.slice(-30);
    });
  }, []);

  // Sync language to localStorage and other tabs
  useEffect(() => {
    localStorage.setItem("drishti-lang", lang);
  }, [lang]);

  // Initialize arbiter and voices on mount
  useEffect(() => {
    // Load voices
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      const loadVoices = () => {
        const voices = window.speechSynthesis.getVoices();
        const hiVoice = voices.find(
          (v) =>
            v.lang.toLowerCase().startsWith("hi") ||
            v.lang.toLowerCase().replace("_", "-") === "hi-in"
        ) || null;
        const enVoice =
          voices.find(
            (v) =>
              v.lang.toLowerCase().startsWith("en") ||
              v.lang.toLowerCase().replace("_", "-") === "en-in"
          ) || voices[0] || null;
        hiVoiceRef.current = hiVoice;
        enVoiceRef.current = enVoice;
      };
      loadVoices();
      window.speechSynthesis.addEventListener("voiceschanged", loadVoices);
      return () => window.speechSynthesis.removeEventListener("voiceschanged", loadVoices);
    }
  }, []);

  // Infer priority from message key (matches arbiter.stateful.test.ts logic)
  const inferPriorityFromKey = (key: string): 0 | 1 | 2 | 3 => {
    if (key === "emergency") return 0;
    if (key.startsWith("hazard:") || key.startsWith("status:")) return 1;
    if (key.startsWith("nav:")) return 2;
    if (key.startsWith("adv:")) return 3;
    return 3;
  };

  // Arbiter speak callback - uses playClipOrTTS with TTS fallback (same as MainApp)
  const speakFn = useCallback(
    async (
      text: string,
      language: "en" | "hi",
      key: string,
      _responseReceivedPerfMs?: number,
      clipKey?: string,
      clipType?: "hazards" | "system"
    ) => {
      if (!text || text === "unknown") return;

      const priority = inferPriorityFromKey(key);

      // Bump generation: any pending handlers from the old utterance are now stale
      const thisGen = ++utteranceGenRef.current;

      setSpeaking(key);
      setQueue((q) => q.filter((k) => k !== key)); // Remove from queue when speaking
      addLog(`speak key=${key} priority=${priority} gen=${thisGen} synth.speaking=${window.speechSynthesis?.speaking} synth.pending=${window.speechSynthesis?.pending}`);

      // Shared start/end handlers for both clip and TTS
      const onSpeechStart = () => {
        // Ignore if this utterance has been superseded
        if (utteranceGenRef.current !== thisGen) {
          addLog(`onSpeechStart IGNORED key=${key} gen=${thisGen} currentGen=${utteranceGenRef.current}`);
          return;
        }
        setSpeaking(key);
        arbiterRef.current?.onSpeechStart(priority);
        addLog(`onSpeechStart key=${key} gen=${thisGen}`);
      };
      const onSpeechEnd = (reason?: string) => {
        // Ignore if this utterance has been superseded
        if (utteranceGenRef.current !== thisGen) {
          addLog(`onSpeechEnd IGNORED key=${key} gen=${thisGen} currentGen=${utteranceGenRef.current} reason=${reason}`);
          return;
        }
        setSpeaking(null);
        setQueue((q) => q.filter((k) => k !== key));
        arbiterRef.current?.onSpeechEnd();
        addLog(`onSpeechEnd key=${key} gen=${thisGen} reason=${reason || "end"}`);
      };

      // TTS fallback (same as MainApp)
      const ttsFallback = (fallbackText: string, fallbackLang: "en" | "hi") => {
        const utterance = new SpeechSynthesisUtterance(fallbackText);
        utterance.lang = fallbackLang === "hi" && hiVoiceRef.current ? "hi-IN" : "en-IN";
        const selectedVoice = fallbackLang === "hi" ? hiVoiceRef.current || enVoiceRef.current : enVoiceRef.current;
        if (selectedVoice) {
          utterance.voice = selectedVoice;
        }

        utterance.onstart = onSpeechStart;
        utterance.onend = () => onSpeechEnd("end");
        utterance.onerror = (e) => onSpeechEnd(e.error || "error");

        window.speechSynthesis.speak(utterance);
        addLog(`speechSynthesis.speak key=${key} gen=${thisGen}`);
      };

      // Use pre-rendered clip if available, otherwise TTS
      if (clipKey && clipType) {
        await playClipOrTTS(text, language, clipKey, clipType, ttsFallback, onSpeechStart, onSpeechEnd);
      } else {
        ttsFallback(text, language);
      }
    },
    [addLog]
  );

  // Arbiter cancel callback - stops BOTH speechSynthesis AND audio clips
  // For Android Chrome: wait ~50ms after cancel before next speak
  const cancelFn = useCallback(
    async (priority?: number) => {
      addLog(`cancel requested priority=${priority} synth.speaking=${window.speechSynthesis?.speaking} synth.pending=${window.speechSynthesis?.pending}`);
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
      stopClip(); // Stop any playing audio clip
      // Bump generation so any late onend/onerror from the cancelled utterance is ignored
      utteranceGenRef.current += 1;
      addLog(`cancel executed gen bumped to ${utteranceGenRef.current}`);
      // For P0/P1, wait ~50ms to let stale events drain before next speak
      if (priority !== undefined && priority <= 1) {
        await new Promise((r) => setTimeout(r, 50));
        addLog(`cancel wait done priority=${priority}`);
      }
      arbiterRef.current?.onSpeechEnd(); // Reset arbiter state
      setSpeaking(null);
    },
    [addLog]
  );

  // Counter for unique P1 keys (avoids 4s dedupe on repeated taps)
  const p1TapCounterRef = useRef<number>(0);

  useEffect(() => {
    arbiterRef.current = new PriorityArbiter(speakFn, cancelFn, {
      onDecision: (decision, msg) => {
        const reason = "reason" in decision ? decision.reason : "unknown";
        addLog(`arbiter: ${decision.type}:${reason} key=${msg?.key ?? "?"} queue=${arbiterRef.current?.["queue"]?.length ?? 0}`);
      },
    });
    return () => {
      arbiterRef.current?.clear();
      arbiterRef.current = null;
    };
  }, [speakFn, cancelFn, addLog]);

  const enqueue = (msg: ArbiterMessage) => {
    const result = arbiterRef.current?.enqueue(msg);
    if (result) {
      setQueue((q) => [...q, msg.key]);
    }
  };

  // Build demo messages from phrases.json (no hardcoded English strings)
  // P0: Emergency - uses system message
  // P1: Hazard - uses buildPhrase for vehicle center (unique key per tap to avoid dedupe)
  // P2: Navigation - neutral demo message
  // P3: Advisory - neutral demo message (not "clear" or safety claim)
  // Status: Vision paused - uses system message
  const buildDemoMessages = useCallback(() => {
    const vehicleCenter = {
      type: "vehicle",
      direction: "center",
      distance: "near" as const,
      urgency: 3,
      confidence: 0.95,
    };
    const p1Text = buildPhrase(vehicleCenter, lang); // e.g., "Vehicle ahead, step left" / "गाड़ी आगे, बाएँ हटें"
    const p3Text = lang === "hi" ? "डेमो संदेश, प्राथमिकता तीन" : "Demo message, priority three";
    // Unique key for P1 each tap: includes counter to bypass 4s dedupe
    const p1Key = `hazard:vehicle:center:${p1TapCounterRef.current++}`;

    return {
      p0: makeEmergencyMessage(
        lang === "hi" ? "आपातकाल शुरू" : "Emergency triggered",
        lang
      ),
      p1: makeHazardMessage("vehicle", "center", p1Text, lang, 3, 0.95, undefined, undefined, p1Key),
      p2: makeNavMessage(
        lang === "hi" ? "बाएँ मुड़ें, ३० कदम में" : "Turn left in 30 steps",
        lang,
        "demo-nav"
      ),
      p3: makeAdvisoryMessage(p3Text, lang, "demo-advisory"),
      status: makeVisionPausedMessage(lang),
    };
  }, [lang]);

  // Priority button handlers
  const sendP0 = () => enqueue(buildDemoMessages().p0);
  const sendP1 = () => enqueue(buildDemoMessages().p1);
  const sendP2 = () => enqueue(buildDemoMessages().p2);
  const sendP3 = () => enqueue(buildDemoMessages().p3);
  const sendStatus = () => enqueue(buildDemoMessages().status);
  const clearAll = () => {
    arbiterRef.current?.clear();
    setQueue([]);
    setSpeaking(null);
  };

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
        <p style={{ margin: 0, opacity: 0.7, fontSize: "0.9rem" }}>Demo: Priority Arbiter</p>
      </header>

      <section
        style={{
          width: "100%",
          maxWidth: "640px",
          background: "#18181b",
          border: "1px solid #27272a",
          borderRadius: "8px",
          padding: "1rem",
          boxSizing: "border-box",
          marginBottom: "1rem",
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

      <section
        style={{
          width: "100%",
          maxWidth: "640px",
          background: "#18181b",
          border: "1px solid #27272a",
          borderRadius: "8px",
          padding: "1rem",
          boxSizing: "border-box",
          marginBottom: "1rem",
        }}
      >
        <h2 style={{ fontSize: "1rem", margin: "0 0 0.8rem 0", color: "#a1a1aa" }}>Priority Buttons</h2>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
          <button
            onClick={sendP0}
            style={{
              gridColumn: "span 2",
              padding: "0.9rem",
              fontSize: "1.1rem",
              fontWeight: "bold",
              borderRadius: "8px",
              border: "none",
              background: "#dc2626",
              color: "white",
              cursor: "pointer",
            }}
          >
            P0: Emergency
          </button>
          <button
            onClick={sendP1}
            style={{
              padding: "0.9rem",
              fontSize: "1rem",
              borderRadius: "8px",
              border: "none",
              background: "#ea580c",
              color: "white",
              cursor: "pointer",
            }}
          >
            P1: Hazard (Vehicle)
          </button>
          <button
            onClick={sendStatus}
            style={{
              padding: "0.9rem",
              fontSize: "1rem",
              borderRadius: "8px",
              border: "none",
              background: "#ca8a04",
              color: "white",
              cursor: "pointer",
            }}
          >
            P1: Status (Vision Paused)
          </button>
          <button
            onClick={sendP2}
            style={{
              padding: "0.9rem",
              fontSize: "1rem",
              borderRadius: "8px",
              border: "none",
              background: "#2563eb",
              color: "white",
              cursor: "pointer",
            }}
          >
            P2: Navigation
          </button>
          <button
            onClick={sendP3}
            style={{
              padding: "0.9rem",
              fontSize: "1rem",
              borderRadius: "8px",
              border: "none",
              background: "#64748b",
              color: "white",
              cursor: "pointer",
            }}
          >
            P3: Advisory
          </button>
          <button
            onClick={clearAll}
            style={{
              gridColumn: "span 2",
              padding: "0.9rem",
              fontSize: "1rem",
              borderRadius: "8px",
              border: "1px solid #52525b",
              background: "#27272a",
              color: "#fafafa",
              cursor: "pointer",
            }}
          >
            Clear All
          </button>
        </div>
      </section>

      <section
        style={{
          width: "100%",
          maxWidth: "640px",
          background: "#18181b",
          border: "1px solid #27272a",
          borderRadius: "8px",
          padding: "1rem",
          boxSizing: "border-box",
          marginBottom: "1rem",
        }}
      >
        <h2 style={{ fontSize: "1rem", margin: "0 0 0.8rem 0", color: "#a1a1aa" }}>Arbiter State</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <div
            style={{
              padding: "0.8rem",
              borderRadius: "6px",
              background: speaking ? "#1e3a5f" : "#27272a",
              border: "1px solid " + (speaking ? "#2563eb" : "#52525b"),
            }}
          >
            <strong>Currently Speaking:</strong> {speaking ? ` ${speaking}` : " (none)"}
          </div>
          <div style={{ padding: "0.8rem", borderRadius: "6px", background: "#27272a", border: "1px solid #52525b" }}>
            <strong>Queue ({queue.length}):</strong>
            {queue.length === 0 ? (
              <span style={{ marginLeft: "0.5rem", color: "#a1a1aa" }}> (empty)</span>
            ) : (
              <ul style={{ margin: "0.5rem 0 0 1.5rem", padding: 0 }}>
                {queue.map((key, i) => (
                  <li key={`${key}-${i}`} style={{ fontSize: "0.9rem" }}>
                    {key}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      {/* Event Log */}
      <section
        style={{
          width: "100%",
          maxWidth: "640px",
          background: "#18181b",
          border: "1px solid #27272a",
          borderRadius: "8px",
          padding: "1rem",
          boxSizing: "border-box",
          marginBottom: "1rem",
        }}
      >
        <h2 style={{ fontSize: "1rem", margin: "0 0 0.8rem 0", color: "#a1a1aa" }}>Event Log (last 30)</h2>
        <div
          style={{
            fontFamily: "monospace",
            fontSize: "0.75rem",
            lineHeight: "1.4",
            maxHeight: "200px",
            overflow: "auto",
            background: "#0a0a0a",
            padding: "0.5rem",
            borderRadius: "4px",
            border: "1px solid #27272a",
            whiteSpace: "pre-wrap",
          }}
        >
          {logs.length === 0 ? (
            <span style={{ color: "#a1a1aa" }}>(empty)</span>
          ) : (
            logs
              .slice()
              .reverse()
              .map((log, i) => (
                <div key={i} style={{ color: "#38bdf8" }}>
                  {log}
                </div>
              ))
          )}
        </div>
      </section>

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

/** Simple hash-based router */
export default function RootApp() {
  const [hash, setHash] = useState(() => window.location.hash.slice(1) || "app");

  useEffect(() => {
    const onHashChange = () => setHash(window.location.hash.slice(1) || "app");
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  if (hash === "demo") return <DemoPage />;
  return <MainApp />;
}
