import { useState, useRef, useEffect, useCallback } from "react";
import { buildPhrase } from "./phrases";

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

export default function App() {
  const [isRunning, setIsRunning] = useState(false);
  const [lang, setLang] = useState<"en" | "hi">("en");
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

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const inFlightRef = useRef<number>(0);
  const isPendingPreviousRef = useRef<boolean>(false);
  const intervalIdRef = useRef<number | null>(null);
  const hiVoiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const enVoiceRef = useRef<SpeechSynthesisVoice | null>(null);

  const getUtterancesQueued = useCallback(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return 0;
    return (window.speechSynthesis.pending ? 1 : 0) + (window.speechSynthesis.speaking ? 1 : 0);
  }, []);

  const speak = useCallback(
    (
      text: string,
      language: "en" | "hi",
      responseReceivedPerfMs: number,
      currentDurations: FrameDurations
    ) => {
      if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
      if (!text || text === "unknown") return;

      // Fix backlog: cancel current speech and speak only newest result
      window.speechSynthesis.cancel();

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = language === "hi" && hiVoiceRef.current ? "hi-IN" : "en-IN";
      const selectedVoice = language === "hi" ? hiVoiceRef.current || enVoiceRef.current : enVoiceRef.current;
      if (selectedVoice) {
        utterance.voice = selectedVoice;
      }

      utterance.onstart = () => {
        const speechStartDelay = Math.round(performance.now() - responseReceivedPerfMs);
        currentDurations.responseToSpeechStart = speechStartDelay;
        setDurations({ ...currentDurations });
        setQueuedUtterances(getUtterancesQueued());
      };

      utterance.onend = () => {
        setQueuedUtterances(getUtterancesQueued());
      };

      utterance.onerror = () => {
        setQueuedUtterances(getUtterancesQueued());
      };

      window.speechSynthesis.speak(utterance);
      setLastSpoken(text);
      setQueuedUtterances(getUtterancesQueued());
    },
    [getUtterancesQueued]
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

          // Announce Vision limited if 3 consecutive failures reached
          if (data.perception?.instruction === "Vision limited") {
            speak(lang === "hi" ? "दृष्टि सीमित" : "Vision limited", lang, respReceivedPerfMs, currentDurations);
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
            speak(phrase, lang, respReceivedPerfMs, currentDurations);
          }
        } catch (err) {
          setStatusMsg(`Request error: ${err instanceof Error ? err.message : String(err)}`);
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
  }, [lang, speak, getUtterancesQueued, staleThresholdSec]);

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
    if (videoRef.current && videoRef.current.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach((track) => track.stop());
      videoRef.current.srcObject = null;
    }
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
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
