import React, { useEffect, useRef, useState } from "react";
import { Tier1Detector } from "./detector";
import {
  BenchmarkResult,
  Direction,
  Tier1Alert,
  Tier1Config,
  Tier1HazardType,
  Tier1Metrics,
  TrackDecisionLog,
  TrackedObject,
} from "./types";
import { DEFAULT_TIER1_CONFIG } from "./config";
import { buildPhrase } from "../phrases";
import { PriorityArbiter, makeHazardMessage } from "../arbiter";
import {
  DEFAULT_SAMPLE_INTERVAL_SEC,
  VideoClipSampler,
  VideoDiagnostics,
  createMissedHazardLog,
  extractDiagnostics,
  formatAlertsToCsv,
  formatDecisionsToCsv,
  getFfmpegConversionCommand,
  isHevcClip,
} from "./eval_stepper";

interface LoggedAlert {
  id: string;
  timeSec: number;
  alert: Tier1Alert;
  phraseEn: string;
  phraseHi: string;
  label?: "True" | "False" | "Missed" | "";
}

export function Tier1ReviewPage({ onBack }: { onBack: () => void }): React.ReactElement {
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [loadedFileName, setLoadedFileName] = useState<string>("clip");
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoadedData, setIsLoadedData] = useState(false);
  const [sampleIntervalSec, setSampleIntervalSec] = useState<number>(DEFAULT_SAMPLE_INTERVAL_SEC);
  const [samplerMode, setSamplerMode] = useState<"rvfc" | "seek">("rvfc");

  const [metrics, setMetrics] = useState<Tier1Metrics>({
    fps: 0,
    latencyMs: 0,
    backend: "initializing",
    loadTimeMs: 0,
    status: "idle",
  });
  const [alertLogs, setAlertLogs] = useState<LoggedAlert[]>([]);
  const [decisionLogs, setDecisionLogs] = useState<TrackDecisionLog[]>([]);
  const [decisionFilter, setDecisionFilter] = useState<"all" | "alerted" | "suppressed">("all");
  const [activeAlert, setActiveAlert] = useState<Tier1Alert | null>(null);
  const [clipDuration, setClipDuration] = useState<number>(0);
  const [currentVideoTime, setCurrentVideoTime] = useState<number>(0);
  const [stallMessage, setStallMessage] = useState<string | null>(null);
  const [evalCompletedMessage, setEvalCompletedMessage] = useState<string | null>(null);
  const [hevcError, setHevcError] = useState<boolean>(false);
  const [showMissedModal, setShowMissedModal] = useState<boolean>(false);
  const [missedType, setMissedType] = useState<Tier1HazardType>("person");
  const [missedDirection, setMissedDirection] = useState<Direction>("center");

  // Video diagnostics (Req 1)
  const [diagnostics, setDiagnostics] = useState<VideoDiagnostics>({
    readyState: 0,
    readyStateText: "0: HAVE_NOTHING",
    networkState: 0,
    networkStateText: "0: NETWORK_EMPTY",
    errorCode: null,
    errorMessage: null,
    duration: 0,
    videoWidth: 0,
    videoHeight: 0,
    lastEvents: [],
  });

  const samplerRef = useRef<VideoClipSampler | null>(null);

  // Live threshold tuning state
  const [config, setConfig] = useState<Tier1Config>({ ...DEFAULT_TIER1_CONFIG });

  // Live Benchmark state (100 frames, measured via performance.now())
  const [isBenchmarking, setIsBenchmarking] = useState(false);
  const [benchmarkResults, setBenchmarkResults] = useState<BenchmarkResult[]>([]);
  const [benchmarkStatus, setBenchmarkStatus] = useState<string>("");

  // Clip Evaluation state
  const [isEvaluatingClip, setIsEvaluatingClip] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const detectorRef = useRef<Tier1Detector | null>(null);

  useEffect(() => {
    const detector = new Tier1Detector(config);
    detectorRef.current = detector;

    detector.onMetrics((m) => {
      setMetrics(m);
    });

    detector.onAlert((alert) => {
      setActiveAlert(alert);
      const currentTime = videoRef.current ? videoRef.current.currentTime : 0;
      const phraseEn = buildPhrase(
        {
          type: alert.type,
          direction: alert.direction,
          clear_side: alert.clear_side,
          label: alert.label,
        },
        "en"
      );
      const phraseHi = buildPhrase(
        {
          type: alert.type,
          direction: alert.direction,
          clear_side: alert.clear_side,
          label: alert.label,
        },
        "hi"
      );

      const alertId = `alert_${currentTime.toFixed(2)}_${alert.type}_${alert.direction}_${Date.now()}`;

      setAlertLogs((prev) => [
        {
          id: alertId,
          timeSec: Math.round(currentTime * 100) / 100,
          alert,
          phraseEn,
          phraseHi,
          label: "",
        },
        ...prev.slice(0, 99),
      ]);
    });

    detector.onDecision((d) => {
      setDecisionLogs((prev) => [
        { ...d, clip: loadedFileName },
        ...prev.slice(0, 499),
      ]);
    });

    detector.start();

    return () => {
      detector.stop();
      samplerRef.current?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedFileName]);

  // Attach media event listeners to video element (Req 1 & 2)
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    video.muted = true;
    video.playsInline = true;

    const events = [
      "loadedmetadata",
      "loadeddata",
      "canplay",
      "canplaythrough",
      "seeking",
      "seeked",
      "play",
      "playing",
      "pause",
      "waiting",
      "stalled",
      "error",
      "ended",
    ];

    const listener = (e: Event) => {
      const eventName = e.type;
      if (eventName === "loadeddata" || eventName === "canplay") {
        setIsLoadedData(true);
        if (video.duration) setClipDuration(video.duration);
      }
      if (eventName === "error") {
        setIsLoadedData(false);
      }
      setDiagnostics((prev) => extractDiagnostics(video, prev.lastEvents, eventName));
    };

    events.forEach((ev) => video.addEventListener(ev, listener));

    // Initial check
    if (video.readyState >= 2) {
      setIsLoadedData(true);
    }
    setDiagnostics((prev) => extractDiagnostics(video, prev.lastEvents));

    return () => {
      events.forEach((ev) => video.removeEventListener(ev, listener));
    };
  }, [videoSrc]);

  const handleConfigChange = (key: keyof Tier1Config, val: number) => {
    const nextConfig = { ...config, [key]: val };
    setConfig(nextConfig);
    detectorRef.current?.updateConfig(nextConfig);
  };

  const handlePersonThresholdChange = (val: number) => {
    const nextConfig = {
      ...config,
      perClassClosingThreshold: {
        ...config.perClassClosingThreshold,
        person: val,
      },
    };
    setConfig(nextConfig);
    detectorRef.current?.updateConfig(nextConfig);
  };

  const handleInputSizeChange = (val: 192 | 256 | 320) => {
    const nextConfig = { ...config, inputSize: val };
    setConfig(nextConfig);
    detectorRef.current?.updateConfig(nextConfig);
  };

  const handleSwitchBackend = async (backend: "webgl" | "wasm" | "cpu") => {
    if (!detectorRef.current) return;
    const switched = await detectorRef.current.switchBackend(backend);
    setMetrics((prev) => ({ ...prev, backend: switched }));
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (videoSrc) URL.revokeObjectURL(videoSrc);
      const url = URL.createObjectURL(file);
      setVideoSrc(url);
      setLoadedFileName(file.name);
      setIsLoadedData(false); // Enable buttons only after loadeddata (Req 2)
      setAlertLogs([]);
      setDecisionLogs([]);
      setActiveAlert(null);
      setStallMessage(null);
      setEvalCompletedMessage(null);
      setCurrentVideoTime(0);

      // Check if HEVC
      const isHevc = isHevcClip({ name: file.name, type: file.type });
      setHevcError(isHevc);
    }
  };

  const handleLabelAlert = (id: string, label: "True" | "False" | "Missed") => {
    setAlertLogs((prev) =>
      prev.map((a) => (a.id === id ? { ...a, label: a.label === label ? "" : label } : a))
    );
  };

  const handleLabelDecision = (id: string, label: "True" | "False") => {
    setDecisionLogs((prev) =>
      prev.map((d) => (d.id === id ? { ...d, label: d.label === label ? "" : label } : d))
    );
  };

  const handleOpenMissedModal = () => {
    samplerRef.current?.pause();
    setIsPlaying(false);
    setShowMissedModal(true);
  };

  const handleSaveMissedHazard = () => {
    const t = videoRef.current ? Math.round(videoRef.current.currentTime * 100) / 100 : currentVideoTime;
    const newMissed = createMissedHazardLog(loadedFileName, t, missedType, missedDirection);
    setDecisionLogs((prev) => [newMissed, ...prev]);
    setShowMissedModal(false);
  };

  const exportDecisionsCsv = () => {
    const csvContent = formatDecisionsToCsv(decisionLogs, loadedFileName);
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `${loadedFileName || "clip"}_tier1_decisions_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const exportAlertsCsv = () => {
    const csvContent = formatAlertsToCsv(alertLogs, loadedFileName);
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `${loadedFileName || "clip"}_tier1_alerts_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // Run live 100-frame benchmark on installed runtimes
  const runLiveBenchmark = async () => {
    if (!detectorRef.current || isBenchmarking) return;
    setIsBenchmarking(true);
    setBenchmarkResults([]);

    const runtimes: Array<{ backend: "webgl" | "wasm" | "cpu"; inputSize: 192 | 256 | 320 }> = [
      { backend: "webgl", inputSize: 320 },
      { backend: "webgl", inputSize: 256 },
      { backend: "webgl", inputSize: 192 },
      { backend: "wasm", inputSize: 256 },
      { backend: "wasm", inputSize: 192 },
    ];

    const results: BenchmarkResult[] = [];
    for (const r of runtimes) {
      setBenchmarkStatus(`Running 100 frames through ${r.backend} (${r.inputSize} px)...`);
      try {
        const res = await detectorRef.current.runBenchmark(r.backend, r.inputSize, 100);
        results.push(res);
        setBenchmarkResults([...results]);
      } catch (err) {
        results.push({
          backend: r.backend,
          inputSize: r.inputSize,
          numFrames: 0,
          medianMs: 0,
          p95Ms: 0,
          fps: 0,
          totalElapsedMs: 0,
          error: String(err),
        });
        setBenchmarkResults([...results]);
      }
    }

    setBenchmarkStatus("Benchmark complete.");
    setIsBenchmarking(false);
  };

  const drawOverlay = (tracks: TrackedObject[], width: number, height: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    ctx.clearRect(0, 0, width, height);

    // Draw direction thirds
    ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);

    const thirdW = width / 3;
    ctx.beginPath();
    ctx.moveTo(thirdW, 0);
    ctx.lineTo(thirdW, height);
    ctx.moveTo(thirdW * 2, 0);
    ctx.lineTo(thirdW * 2, height);
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw third labels
    ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
    ctx.font = "11px monospace";
    ctx.fillText("LEFT", 8, 20);
    ctx.fillText("CENTER (PATH)", thirdW + 8, 20);
    ctx.fillText("RIGHT", thirdW * 2 + 8, 20);

    // Draw tracked bounding boxes
    for (const track of tracks) {
      const [x, y, w, h] = track.bbox;
      const isUrgent = track.consecutiveFrames >= 4;

      ctx.strokeStyle = isUrgent ? "#ef4444" : "#eab308";
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, w, h);

      // Label background
      ctx.fillStyle = isUrgent ? "rgba(239, 68, 68, 0.85)" : "rgba(234, 179, 8, 0.85)";
      const label = `${track.hazardType} #${track.id} (${track.consecutiveFrames}f)`;
      ctx.font = "12px sans-serif";
      const textMetrics = ctx.measureText(label);
      ctx.fillRect(x, Math.max(0, y - 20), textMetrics.width + 8, 20);

      // Label text
      ctx.fillStyle = "#ffffff";
      ctx.fillText(label, x + 4, Math.max(14, y - 5));
    }
  };

  // requestVideoFrameCallback sampling with seek fallback (Req 3)
  const handleStartSampler = async () => {
    const video = videoRef.current;
    const detector = detectorRef.current;
    if (!video || !detector || !videoSrc || !isLoadedData || isPlaying) return;

    setStallMessage(null);
    setEvalCompletedMessage(null);
    setIsPlaying(true);

    const sampler = new VideoClipSampler(
      video,
      {
        onStep: async (mediaTime) => {
          setCurrentVideoTime(mediaTime);
          const res = await detector.detectFrame(video, mediaTime);
          drawOverlay(res.updatedTracks, video.videoWidth, video.videoHeight);
        },
        onProgress: (cur, dur) => {
          setCurrentVideoTime(cur);
          setClipDuration(dur);
        },
        onStall: (msg) => {
          setStallMessage(msg);
          setIsPlaying(false);
        },
        onError: (err) => {
          setStallMessage(err);
          setIsPlaying(false);
        },
        onComplete: () => {
          setIsPlaying(false);
        },
        onPause: () => {
          setIsPlaying(false);
        },
        isDetectorIdle: () => !detector.isBusy(),
      },
      sampleIntervalSec
    );

    samplerRef.current = sampler;
    setSamplerMode(sampler.getMode());
    await sampler.start(video.currentTime > 0 && video.currentTime < (video.duration || 0));
  };

  const handlePauseSampler = () => {
    samplerRef.current?.pause();
    setIsPlaying(false);
  };

  const handleCancelSampler = () => {
    samplerRef.current?.cancel();
    setIsPlaying(false);
    if (videoRef.current) {
      videoRef.current.currentTime = 0;
      setCurrentVideoTime(0);
    }
  };

  // Run Clip Evaluation automatically across whole clip (Req 4)
  const runClipEvaluation = async () => {
    const video = videoRef.current;
    if (!video || !videoSrc || !isLoadedData || isEvaluatingClip) return;

    setIsEvaluatingClip(true);
    setStallMessage(null);
    setEvalCompletedMessage(null);

    const detector = detectorRef.current;
    if (!detector) {
      setIsEvaluatingClip(false);
      return;
    }

    // Reset detector state and previous logs for clean eval run
    detector.clear();
    setAlertLogs([]);
    setDecisionLogs([]);

    // Live priority arbiter
    const clipArbiter = new PriorityArbiter(
      () => {},
      () => {},
      { hazardMinIntervalMs: 1500, hazardDedupeMs: 4000 }
    );

    const unsubAlert = detector.onAlert((alert) => {
      const phrase = buildPhrase(
        {
          type: alert.type,
          direction: alert.direction,
          clear_side: alert.clear_side,
          label: alert.label,
        },
        "en"
      );
      if (phrase) {
        clipArbiter.enqueue(
          makeHazardMessage(
            alert.type,
            alert.direction,
            phrase,
            "en",
            alert.urgency,
            alert.confidence,
            performance.now(),
            alert.clear_side
          )
        );
      }
    });

    try {
      video.currentTime = 0;
      setCurrentVideoTime(0);

      const sampler = new VideoClipSampler(
        video,
        {
          onStep: async (mediaTime) => {
            setCurrentVideoTime(mediaTime);
            const res = await detector.detectFrame(video, mediaTime);
            drawOverlay(res.updatedTracks, video.videoWidth, video.videoHeight);
          },
          onStall: (msg) => {
            setStallMessage(msg);
          },
          onError: (msg) => {
            setStallMessage(msg);
          },
          isDetectorIdle: () => !detector.isBusy(),
        },
        sampleIntervalSec
      );

      samplerRef.current = sampler;
      setSamplerMode(sampler.getMode());
      await sampler.start(false);

      setEvalCompletedMessage(
        `Evaluation finished (${video.duration.toFixed(1)}s). Review alert list below for True/False/Missed marking and CSV export.`
      );
    } finally {
      unsubAlert();
      setIsEvaluatingClip(false);
    }
  };

  const alertsPerMin =
    clipDuration > 0
      ? (alertLogs.length / (clipDuration / 60)).toFixed(1)
      : (0.0).toFixed(1);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#09090b",
        color: "#f4f4f5",
        fontFamily: "system-ui, -apple-system, sans-serif",
        padding: "1rem",
        boxSizing: "border-box",
      }}
    >
      {/* Header */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "1rem",
          borderBottom: "1px solid #27272a",
          paddingBottom: "0.8rem",
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: "1.35rem" }}>Tier 1 On-Device Review & Benchmark</h1>
          <p style={{ margin: "0.2rem 0 0", color: "#a1a1aa", fontSize: "0.82rem" }}>
            Android Chrome hardware sampling (rVFC), diagnostic telemetry, and verifiable decisions
          </p>
        </div>
        <button
          onClick={onBack}
          style={{
            padding: "6px 14px",
            background: "#27272a",
            color: "#f4f4f5",
            border: "1px solid #3f3f46",
            borderRadius: "6px",
            cursor: "pointer",
            fontSize: "0.85rem",
          }}
        >
          &larr; Back to Live Vision
        </button>
      </header>

      {/* Video file picker & Evaluation trigger */}
      <div style={{ marginBottom: "1rem", display: "flex", flexWrap: "wrap", alignItems: "center", gap: "1rem" }}>
        <label
          style={{
            display: "inline-block",
            padding: "8px 16px",
            background: "#2563eb",
            color: "#ffffff",
            borderRadius: "6px",
            cursor: "pointer",
            fontWeight: "bold",
            fontSize: "0.85rem",
          }}
        >
          Select Video Clip
          <input
            type="file"
            accept="video/*"
            onChange={handleFileChange}
            style={{ display: "none" }}
          />
        </label>
        <span style={{ fontSize: "0.85rem", color: "#a1a1aa" }}>
          {videoSrc
            ? `${loadedFileName} (${clipDuration.toFixed(1)}s) \u2014 ${
                !isLoadedData
                  ? "Loading media (awaiting loadeddata)..."
                  : isPlaying
                  ? "Playing & Analyzing"
                  : "Loaded & Ready"
              }`
            : "Load an eval clip (.mp4, .webm)"}
        </span>
        {videoSrc && (
          <button
            onClick={runClipEvaluation}
            disabled={!isLoadedData || isEvaluatingClip || isPlaying}
            style={{
              padding: "8px 16px",
              background: !isLoadedData || isEvaluatingClip || isPlaying ? "#3f3f46" : "#16a34a",
              color: "#ffffff",
              border: "none",
              borderRadius: "6px",
              cursor: !isLoadedData || isEvaluatingClip || isPlaying ? "not-allowed" : "pointer",
              fontWeight: "bold",
              fontSize: "0.85rem",
            }}
          >
            {isEvaluatingClip ? "Running Whole Clip..." : "Run Clip Evaluation"}
          </button>
        )}
      </div>

      {/* Evaluation completion banner (Req 4) */}
      {evalCompletedMessage && (
        <div
          style={{
            background: "rgba(22, 163, 74, 0.15)",
            border: "1px solid #16a34a",
            color: "#86efac",
            padding: "0.75rem 1rem",
            borderRadius: "6px",
            marginBottom: "1rem",
            fontSize: "0.85rem",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span>✅ {evalCompletedMessage}</span>
          <button
            onClick={() => setEvalCompletedMessage(null)}
            style={{ background: "transparent", border: "none", color: "#86efac", cursor: "pointer", fontSize: "0.9rem" }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Video Diagnostics HUD (Requirement 1) */}
      <section
        style={{
          background: "#18181b",
          border: "1px solid #27272a",
          borderRadius: "6px",
          padding: "0.8rem",
          marginBottom: "1rem",
          fontSize: "0.8rem",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.6rem" }}>
          <h2 style={{ margin: 0, fontSize: "0.92rem", color: "#38bdf8" }}>
            Video Diagnostics & Media Telemetry
          </h2>
          <span
            style={{
              padding: "2px 8px",
              borderRadius: "4px",
              fontSize: "0.72rem",
              fontWeight: "bold",
              background: isLoadedData ? "#15803d" : "#71717a",
              color: "#fff",
            }}
          >
            {isLoadedData ? "✓ loadeddata Ready (Buttons Enabled)" : "Waiting for loadeddata (Buttons Disabled)"}
          </span>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "0.5rem" }}>
          <div>
            readyState:{" "}
            <strong style={{ color: diagnostics.readyState >= 2 ? "#4ade80" : "#facc15" }}>
              {diagnostics.readyStateText}
            </strong>
          </div>
          <div>
            networkState:{" "}
            <strong style={{ color: "#38bdf8" }}>{diagnostics.networkStateText}</strong>
          </div>
          <div>
            Error Code:{" "}
            <strong style={{ color: diagnostics.errorCode ? "#ef4444" : "#a1a1aa" }}>
              {diagnostics.errorCode ?? "None"}
            </strong>{" "}
            {diagnostics.errorMessage ? `(${diagnostics.errorMessage})` : ""}
          </div>
          <div>
            Duration: <strong>{diagnostics.duration ? `${diagnostics.duration.toFixed(2)}s` : "0.00s"}</strong>
          </div>
          <div>
            Resolution:{" "}
            <strong>
              {diagnostics.videoWidth > 0 ? `${diagnostics.videoWidth} x ${diagnostics.videoHeight}` : "--"}
            </strong>
          </div>
          <div>
            Sampler Engine:{" "}
            <strong style={{ color: samplerMode === "rvfc" ? "#4ade80" : "#facc15" }}>
              {samplerMode === "rvfc" ? "requestVideoFrameCallback" : "Seek Stepper Fallback"}
            </strong>
          </div>
        </div>

        {/* Last 10 Media Events */}
        <div style={{ marginTop: "0.6rem", borderTop: "1px solid #27272a", paddingTop: "0.5rem" }}>
          <div style={{ fontSize: "0.75rem", color: "#a1a1aa", marginBottom: "4px" }}>
            Last 10 Media Events:
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
            {diagnostics.lastEvents.length === 0 ? (
              <span style={{ color: "#71717a", fontSize: "0.75rem" }}>No media events recorded yet.</span>
            ) : (
              diagnostics.lastEvents.map((ev, i) => (
                <span
                  key={i}
                  style={{
                    padding: "2px 6px",
                    background:
                      ev.event === "error" || ev.event === "stalled"
                        ? "#7f1d1d"
                        : ev.event === "loadeddata" || ev.event === "canplay"
                        ? "#14532d"
                        : "#27272a",
                    color:
                      ev.event === "error" || ev.event === "stalled"
                        ? "#fecaca"
                        : ev.event === "loadeddata" || ev.event === "canplay"
                        ? "#86efac"
                        : "#d4d4d8",
                    borderRadius: "3px",
                    fontSize: "0.72rem",
                    fontFamily: "monospace",
                  }}
                >
                  {ev.time}: {ev.event}
                </span>
              ))
            )}
          </div>
        </div>
      </section>

      {/* HUD Metrics & Alerts per Min */}
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
          gap: "0.6rem",
          background: "#18181b",
          padding: "0.8rem",
          borderRadius: "6px",
          marginBottom: "1rem",
          border: "1px solid #27272a",
          fontSize: "0.85rem",
        }}
      >
        <div>
          Backend: <strong style={{ color: "#38bdf8" }}>{metrics.backend}</strong>
        </div>
        <div>
          Load Time: <strong>{metrics.loadTimeMs} ms</strong>
        </div>
        <div>
          FPS: <strong style={{ color: "#4ade80" }}>{metrics.fps}</strong>
        </div>
        <div>
          Latency: <strong style={{ color: "#facc15" }}>{metrics.latencyMs} ms</strong>
        </div>
        <div>
          Alerts / Min: <strong style={{ color: "#f43f5e" }}>{alertsPerMin}</strong>
        </div>
      </section>

      {/* Active Alert banner */}
      {activeAlert && (
        <div
          style={{
            padding: "0.6rem 1rem",
            background: activeAlert.urgency === 3 ? "#991b1b" : "#9a3412",
            borderRadius: "6px",
            marginBottom: "1rem",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div>
            <strong>P1 Alert (Urgency {activeAlert.urgency}):</strong> {activeAlert.type} {activeAlert.direction} ({activeAlert.distance})
          </div>
          <span style={{ fontSize: "0.85rem" }}>
            Speed: {activeAlert.closingSpeedPerSec > 0 ? `+${activeAlert.closingSpeedPerSec}/s` : `${activeAlert.closingSpeedPerSec}/s`}
          </span>
        </div>
      )}

      {/* Video & Canvas */}
      {videoSrc ? (
        <div style={{ marginBottom: "1rem" }}>
          {/* HEVC warning if detected */}
          {hevcError && (
            <div
              style={{
                background: "rgba(239, 68, 68, 0.15)",
                border: "1px solid #ef4444",
                borderRadius: "6px",
                padding: "0.8rem 1rem",
                marginBottom: "0.8rem",
              }}
            >
              <h4 style={{ margin: "0 0 0.4rem 0", color: "#f87171", fontSize: "0.95rem" }}>
                ⚠️ HEVC / Unsupported Video Codec
              </h4>
              <p style={{ margin: "0 0 0.4rem 0", fontSize: "0.8rem", color: "#d4d4d8" }}>
                This video cannot be decoded natively by your browser. Convert it to standard H.264 using ffmpeg:
              </p>
              <pre
                style={{
                  background: "#18181b",
                  padding: "6px 10px",
                  borderRadius: "4px",
                  fontSize: "0.75rem",
                  overflowX: "auto",
                  color: "#38bdf8",
                  margin: "0 0 0.5rem 0",
                }}
              >
                {getFfmpegConversionCommand(loadedFileName)}
              </pre>
              <button
                onClick={() => navigator.clipboard.writeText(getFfmpegConversionCommand(loadedFileName))}
                style={{
                  padding: "4px 10px",
                  background: "#ef4444",
                  color: "#fff",
                  border: "none",
                  borderRadius: "4px",
                  fontSize: "0.75rem",
                  cursor: "pointer",
                  fontWeight: "bold",
                }}
              >
                Copy ffmpeg command
              </button>
            </div>
          )}

          {/* Stalled video notice */}
          {stallMessage && (
            <div
              style={{
                background: "#7f1d1d",
                border: "1px solid #ef4444",
                color: "#fecaca",
                padding: "8px 12px",
                borderRadius: "6px",
                marginBottom: "0.8rem",
                fontSize: "0.85rem",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span>⚠️ {stallMessage}</span>
              <button
                onClick={() => setStallMessage(null)}
                style={{ background: "transparent", border: "none", color: "#fff", cursor: "pointer", fontSize: "0.9rem" }}
              >
                ✕
              </button>
            </div>
          )}

          <div style={{ position: "relative", background: "#000", borderRadius: "6px 6px 0 0", overflow: "hidden" }}>
            <video
              ref={videoRef}
              src={videoSrc}
              muted
              playsInline
              preload="auto"
              onError={() => setHevcError(true)}
              style={{ width: "100%", display: "block", maxHeight: "420px" }}
            />
            <canvas
              ref={canvasRef}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: "100%",
                pointerEvents: "none",
              }}
            />
          </div>

          {/* Sampler Control Bar (Req 2, 3, 4) */}
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: "0.5rem",
              background: "#18181b",
              padding: "0.6rem 0.8rem",
              borderRadius: "0 0 6px 6px",
              border: "1px solid #27272a",
              borderTop: "none",
            }}
          >
            <button
              onClick={isPlaying ? handlePauseSampler : handleStartSampler}
              disabled={!isLoadedData || isEvaluatingClip}
              style={{
                padding: "6px 14px",
                background: !isLoadedData || isEvaluatingClip ? "#3f3f46" : isPlaying ? "#f59e0b" : "#16a34a",
                color: "#fff",
                border: "none",
                borderRadius: "4px",
                cursor: !isLoadedData || isEvaluatingClip ? "not-allowed" : "pointer",
                fontWeight: "bold",
                fontSize: "0.8rem",
              }}
            >
              {isPlaying ? "⏸ Pause" : `▶ Play Sampling (${sampleIntervalSec.toFixed(2)}s)`}
            </button>
            <button
              onClick={handleCancelSampler}
              disabled={!isLoadedData || (!isPlaying && currentVideoTime === 0)}
              style={{
                padding: "6px 12px",
                background: !isLoadedData || (!isPlaying && currentVideoTime === 0) ? "#3f3f46" : "#dc2626",
                color: "#fff",
                border: "none",
                borderRadius: "4px",
                cursor: !isLoadedData || (!isPlaying && currentVideoTime === 0) ? "not-allowed" : "pointer",
                fontSize: "0.8rem",
                fontWeight: "bold",
              }}
            >
              ⏹ Cancel
            </button>
            <button
              onClick={handleOpenMissedModal}
              disabled={!isLoadedData || isEvaluatingClip}
              style={{
                padding: "6px 12px",
                background: !isLoadedData || isEvaluatingClip ? "#3f3f46" : "#eab308",
                color: !isLoadedData || isEvaluatingClip ? "#a1a1aa" : "#000",
                border: "none",
                borderRadius: "4px",
                cursor: !isLoadedData || isEvaluatingClip ? "not-allowed" : "pointer",
                fontWeight: "bold",
                fontSize: "0.8rem",
                marginLeft: "auto",
              }}
            >
              + Mark Missed Hazard
            </button>
            <span style={{ fontSize: "0.8rem", color: "#a1a1aa", marginLeft: "0.5rem" }}>
              t = <strong>{currentVideoTime.toFixed(2)}s</strong> / {clipDuration.toFixed(1)}s
            </span>
          </div>
        </div>
      ) : (
        <div
          style={{
            padding: "2.5rem",
            textAlign: "center",
            background: "#18181b",
            borderRadius: "6px",
            color: "#71717a",
            marginBottom: "1rem",
            border: "1px dashed #3f3f46",
          }}
        >
          Select a recorded video clip (.mp4, .webm) above to test detections and bounding boxes.
        </div>
      )}

      {/* Missed Hazard Annotation Modal */}
      {showMissedModal && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0, 0, 0, 0.75)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
          }}
        >
          <div
            style={{
              background: "#18181b",
              padding: "1.2rem",
              borderRadius: "8px",
              width: "320px",
              border: "1px solid #3f3f46",
              boxShadow: "0 10px 25px rgba(0,0,0,0.5)",
            }}
          >
            <h3 style={{ margin: "0 0 0.8rem 0", fontSize: "1rem", color: "#facc15" }}>
              Mark Missed Hazard (t={currentVideoTime.toFixed(2)}s)
            </h3>
            <label style={{ display: "block", fontSize: "0.8rem", marginBottom: "4px", color: "#a1a1aa" }}>
              Hazard Type:
            </label>
            <select
              value={missedType}
              onChange={(e) => setMissedType(e.target.value as Tier1HazardType)}
              style={{
                width: "100%",
                padding: "6px",
                background: "#27272a",
                color: "#fff",
                border: "1px solid #3f3f46",
                borderRadius: "4px",
                marginBottom: "0.8rem",
              }}
            >
              {[
                "person",
                "vehicle",
                "bicycle",
                "animal",
                "chair",
                "table",
                "bench",
                "pole",
                "plant",
                "bag",
                "stairs",
                "step_down",
                "pothole",
                "other",
              ].map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <label style={{ display: "block", fontSize: "0.8rem", marginBottom: "4px", color: "#a1a1aa" }}>
              Direction:
            </label>
            <select
              value={missedDirection}
              onChange={(e) => setMissedDirection(e.target.value as Direction)}
              style={{
                width: "100%",
                padding: "6px",
                background: "#27272a",
                color: "#fff",
                border: "1px solid #3f3f46",
                borderRadius: "4px",
                marginBottom: "1rem",
              }}
            >
              <option value="center">center</option>
              <option value="left">left</option>
              <option value="right">right</option>
            </select>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
              <button
                onClick={() => setShowMissedModal(false)}
                style={{
                  padding: "6px 12px",
                  background: "#27272a",
                  color: "#a1a1aa",
                  border: "1px solid #3f3f46",
                  borderRadius: "4px",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleSaveMissedHazard}
                style={{
                  padding: "6px 14px",
                  background: "#16a34a",
                  color: "#fff",
                  border: "none",
                  borderRadius: "4px",
                  fontWeight: "bold",
                  cursor: "pointer",
                }}
              >
                Save Missed
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Live Benchmark Panel */}
      <section
        style={{
          background: "#18181b",
          borderRadius: "6px",
          padding: "0.8rem",
          border: "1px solid #27272a",
          marginBottom: "1rem",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.6rem" }}>
          <div>
            <h2 style={{ fontSize: "0.95rem", margin: 0, color: "#a1a1aa" }}>
              Live 100-Frame Benchmark (Measured on this Device)
            </h2>
            <p style={{ margin: "2px 0 0", fontSize: "0.75rem", color: "#71717a" }}>
              Runs 100 frames through installed tfjs runtimes using performance.now(). No hardcoded values.
            </p>
          </div>
          <button
            onClick={runLiveBenchmark}
            disabled={isBenchmarking}
            style={{
              padding: "6px 14px",
              background: isBenchmarking ? "#52525b" : "#7c3aed",
              color: "#ffffff",
              border: "none",
              borderRadius: "6px",
              cursor: isBenchmarking ? "not-allowed" : "pointer",
              fontWeight: "bold",
              fontSize: "0.8rem",
            }}
          >
            {isBenchmarking ? "Benchmarking..." : "Run Benchmark (100 frames)"}
          </button>
        </div>

        {benchmarkStatus && (
          <p style={{ fontSize: "0.8rem", color: "#38bdf8", margin: "0 0 0.5rem 0" }}>
            {benchmarkStatus}
          </p>
        )}

        {benchmarkResults.length > 0 ? (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem", textAlign: "left" }}>
              <thead>
                <tr style={{ color: "#a1a1aa", borderBottom: "1px solid #27272a" }}>
                  <th style={{ padding: "6px" }}>Runtime</th>
                  <th style={{ padding: "6px" }}>Input Size</th>
                  <th style={{ padding: "6px" }}>Backend</th>
                  <th style={{ padding: "6px" }}>Median Latency (p50)</th>
                  <th style={{ padding: "6px" }}>p95 Latency</th>
                  <th style={{ padding: "6px" }}>End-to-End FPS</th>
                  <th style={{ padding: "6px" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {benchmarkResults.map((r, i) => (
                  <tr key={i} style={{ borderBottom: "1px solid #27272a" }}>
                    <td style={{ padding: "6px", fontWeight: "bold" }}>tfjs ({r.backend})</td>
                    <td style={{ padding: "6px" }}>{r.inputSize} px</td>
                    <td style={{ padding: "6px", color: "#38bdf8" }}>{r.backend}</td>
                    <td style={{ padding: "6px", color: "#facc15" }}>{r.error ? "Error" : `${r.medianMs} ms`}</td>
                    <td style={{ padding: "6px", color: "#facc15" }}>{r.error ? "Error" : `${r.p95Ms} ms`}</td>
                    <td style={{ padding: "6px", color: "#4ade80", fontWeight: "bold" }}>
                      {r.error ? "N/A" : r.fps}
                    </td>
                    <td style={{ padding: "6px" }}>
                      {!r.error && (
                        <button
                          onClick={() => {
                            handleSwitchBackend(r.backend as "webgl" | "wasm" | "cpu");
                            handleInputSizeChange(r.inputSize as 192 | 256 | 320);
                          }}
                          style={{
                            padding: "3px 8px",
                            background: "#27272a",
                            border: "1px solid #3f3f46",
                            borderRadius: "4px",
                            color: "#ffffff",
                            fontSize: "0.75rem",
                            cursor: "pointer",
                          }}
                        >
                          Use this
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p style={{ color: "#71717a", fontSize: "0.8rem", margin: 0 }}>
            Click "Run Benchmark" to measure real-time performance on this device.
          </p>
        )}
      </section>

      {/* Live Threshold Tuning Panel */}
      <section
        style={{
          background: "#18181b",
          borderRadius: "6px",
          padding: "0.8rem",
          border: "1px solid #27272a",
          marginBottom: "1rem",
        }}
      >
        <h2 style={{ fontSize: "0.95rem", margin: "0 0 0.6rem 0", color: "#a1a1aa" }}>
          Live Threshold Tuning Panel (Time-Based & Resizing)
        </h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "0.8rem", fontSize: "0.8rem" }}>
          <div>
            <label style={{ display: "block", marginBottom: "4px" }}>
              Sample Interval: <strong>{sampleIntervalSec.toFixed(2)} s</strong>
            </label>
            <input
              type="range"
              min="0.1"
              max="1.0"
              step="0.05"
              value={sampleIntervalSec}
              onChange={(e) => {
                const val = parseFloat(e.target.value);
                setSampleIntervalSec(val);
                samplerRef.current?.setSampleInterval(val);
              }}
              style={{ width: "100%" }}
            />
          </div>
          <div>
            <label style={{ display: "block", marginBottom: "4px" }}>
              Input Resolution: <strong>{config.inputSize ?? 320} px</strong>
            </label>
            <select
              value={config.inputSize ?? 320}
              onChange={(e) => handleInputSizeChange(parseInt(e.target.value, 10) as 192 | 256 | 320)}
              style={{ width: "100%", background: "#27272a", color: "#fff", border: "1px solid #3f3f46", padding: "4px", borderRadius: "4px" }}
            >
              <option value={320}>320 px (Standard)</option>
              <option value={256}>256 px (Faster for slower phones)</option>
              <option value={192}>192 px (Fastest / Ultra-low latency)</option>
            </select>
          </div>
          <div>
            <label style={{ display: "block", marginBottom: "4px" }}>
              Active Backend: <strong>{metrics.backend}</strong>
            </label>
            <select
              value={metrics.backend}
              onChange={(e) => handleSwitchBackend(e.target.value as "webgl" | "wasm" | "cpu")}
              style={{ width: "100%", background: "#27272a", color: "#fff", border: "1px solid #3f3f46", padding: "4px", borderRadius: "4px" }}
            >
              <option value="webgl">WebGL</option>
              <option value="wasm">WASM (SIMD)</option>
              <option value="cpu">CPU</option>
            </select>
          </div>
          <div>
            <label style={{ display: "block", marginBottom: "4px" }}>
              Min Track Duration: <strong>{config.minTrackDurationSec ?? 0.8} s</strong>
            </label>
            <input
              type="range"
              min="0.2"
              max="2.0"
              step="0.1"
              value={config.minTrackDurationSec ?? 0.8}
              onChange={(e) => handleConfigChange("minTrackDurationSec", parseFloat(e.target.value))}
              style={{ width: "100%" }}
            />
          </div>
          <div>
            <label style={{ display: "block", marginBottom: "4px" }}>
              Min Sustained Closing: <strong>{config.minClosingDurationSec ?? 0.6} s</strong>
            </label>
            <input
              type="range"
              min="0.2"
              max="1.5"
              step="0.1"
              value={config.minClosingDurationSec ?? 0.6}
              onChange={(e) => handleConfigChange("minClosingDurationSec", parseFloat(e.target.value))}
              style={{ width: "100%" }}
            />
          </div>
          <div>
            <label style={{ display: "block", marginBottom: "4px" }}>
              Default Closing Speed / s: <strong>{config.closingThresholdPerSec}</strong>
            </label>
            <input
              type="range"
              min="0.01"
              max="0.20"
              step="0.01"
              value={config.closingThresholdPerSec}
              onChange={(e) => handleConfigChange("closingThresholdPerSec", parseFloat(e.target.value))}
              style={{ width: "100%" }}
            />
          </div>
          <div>
            <label style={{ display: "block", marginBottom: "4px" }}>
              Person Closing Speed / s: <strong>{config.perClassClosingThreshold.person ?? 0.08}</strong>
            </label>
            <input
              type="range"
              min="0.02"
              max="0.25"
              step="0.01"
              value={config.perClassClosingThreshold.person ?? 0.08}
              onChange={(e) => handlePersonThresholdChange(parseFloat(e.target.value))}
              style={{ width: "100%" }}
            />
          </div>
        </div>
      </section>

      {/* Triggered Alerts Log with True / False / Missed Marking & CSV Export (Req 4) */}
      <section style={{ background: "#18181b", borderRadius: "6px", padding: "0.8rem", border: "1px solid #27272a", marginBottom: "1rem" }}>
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
          <div>
            <h2 style={{ fontSize: "0.95rem", margin: "0 0 0.2rem 0", color: "#a1a1aa" }}>
              Triggered Alerts Log ({alertLogs.length}) &mdash; {alertsPerMin} alerts/min
            </h2>
            <div style={{ fontSize: "0.75rem", color: "#71717a" }}>
              True: <strong style={{ color: "#22c55e" }}>{alertLogs.filter((a) => a.label === "True").length}</strong> | False: <strong style={{ color: "#ef4444" }}>{alertLogs.filter((a) => a.label === "False").length}</strong> | Missed: <strong style={{ color: "#eab308" }}>{alertLogs.filter((a) => a.label === "Missed").length}</strong>
            </div>
          </div>
          <div style={{ display: "flex", gap: "0.4rem" }}>
            <button
              onClick={exportAlertsCsv}
              disabled={alertLogs.length === 0}
              style={{
                padding: "4px 10px",
                background: alertLogs.length === 0 ? "#3f3f46" : "#2563eb",
                border: "none",
                color: "#ffffff",
                borderRadius: "4px",
                fontSize: "0.75rem",
                fontWeight: "bold",
                cursor: alertLogs.length === 0 ? "not-allowed" : "pointer",
              }}
            >
              Export Alerts CSV
            </button>
            <button
              onClick={() => setAlertLogs([])}
              style={{
                padding: "4px 8px",
                background: "#27272a",
                border: "1px solid #3f3f46",
                color: "#a1a1aa",
                borderRadius: "4px",
                fontSize: "0.75rem",
                cursor: "pointer",
              }}
            >
              Clear
            </button>
          </div>
        </div>

        {alertLogs.length === 0 ? (
          <p style={{ color: "#71717a", fontSize: "0.85rem", margin: 0 }}>
            No alerts triggered. Run clip evaluation or play sampler to stream alerts.
          </p>
        ) : (
          <div style={{ maxHeight: "280px", overflowY: "auto", fontSize: "0.78rem" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left" }}>
              <thead>
                <tr style={{ color: "#a1a1aa", borderBottom: "1px solid #27272a" }}>
                  <th style={{ padding: "4px 6px" }}>Time</th>
                  <th style={{ padding: "4px 6px" }}>Hazard</th>
                  <th style={{ padding: "4px 6px" }}>Urg</th>
                  <th style={{ padding: "4px 6px" }}>Dir</th>
                  <th style={{ padding: "4px 6px" }}>Dist</th>
                  <th style={{ padding: "4px 6px" }}>Spoken</th>
                  <th style={{ padding: "4px 6px" }}>Reason</th>
                  <th style={{ padding: "4px 6px", textAlign: "center" }}>Mark Ground Truth</th>
                </tr>
              </thead>
              <tbody>
                {alertLogs.map((log) => (
                  <tr key={log.id} style={{ borderBottom: "1px solid #27272a" }}>
                    <td style={{ padding: "4px 6px", color: "#38bdf8" }}>{log.timeSec.toFixed(2)}s</td>
                    <td style={{ padding: "4px 6px", fontWeight: "bold" }}>{log.alert.type}</td>
                    <td style={{ padding: "4px 6px", color: log.alert.urgency === 3 ? "#ef4444" : "#f97316" }}>
                      {log.alert.urgency}
                    </td>
                    <td style={{ padding: "4px 6px" }}>{log.alert.direction}</td>
                    <td style={{ padding: "4px 6px" }}>{log.alert.distance}</td>
                    <td style={{ padding: "4px 6px" }}>
                      "{log.phraseEn}" / <span style={{ color: "#facc15" }}>"{log.phraseHi}"</span>
                    </td>
                    <td style={{ padding: "4px 6px", fontFamily: "monospace", color: "#a1a1aa", fontSize: "0.72rem" }}>
                      {log.alert.reason}
                    </td>
                    <td style={{ padding: "4px 6px", textAlign: "center" }}>
                      <div style={{ display: "inline-flex", gap: "3px" }}>
                        <button
                          onClick={() => handleLabelAlert(log.id, "True")}
                          style={{
                            padding: "2px 6px",
                            fontSize: "0.68rem",
                            borderRadius: "3px",
                            border: "1px solid #22c55e",
                            background: log.label === "True" ? "#22c55e" : "#18181b",
                            color: log.label === "True" ? "#000" : "#22c55e",
                            fontWeight: log.label === "True" ? "bold" : "normal",
                            cursor: "pointer",
                          }}
                        >
                          True
                        </button>
                        <button
                          onClick={() => handleLabelAlert(log.id, "False")}
                          style={{
                            padding: "2px 6px",
                            fontSize: "0.68rem",
                            borderRadius: "3px",
                            border: "1px solid #ef4444",
                            background: log.label === "False" ? "#ef4444" : "#18181b",
                            color: log.label === "False" ? "#fff" : "#ef4444",
                            fontWeight: log.label === "False" ? "bold" : "normal",
                            cursor: "pointer",
                          }}
                        >
                          False
                        </button>
                        <button
                          onClick={() => handleLabelAlert(log.id, "Missed")}
                          style={{
                            padding: "2px 6px",
                            fontSize: "0.68rem",
                            borderRadius: "3px",
                            border: "1px solid #eab308",
                            background: log.label === "Missed" ? "#eab308" : "#18181b",
                            color: log.label === "Missed" ? "#000" : "#eab308",
                            fontWeight: log.label === "Missed" ? "bold" : "normal",
                            cursor: "pointer",
                          }}
                        >
                          Missed
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Tracked Object Decisions Log */}
      <section
        style={{
          background: "#18181b",
          borderRadius: "6px",
          padding: "0.8rem",
          border: "1px solid #27272a",
          marginBottom: "1rem",
        }}
      >
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: "0.5rem", marginBottom: "0.6rem" }}>
          <div>
            <h2 style={{ fontSize: "0.95rem", margin: 0, color: "#a1a1aa" }}>
              Tracked Object Decisions Log ({decisionLogs.length})
            </h2>
            <div style={{ fontSize: "0.75rem", color: "#71717a", marginTop: "2px" }}>
              Showing {Math.min(200, decisionLogs.length)} of {decisionLogs.length} decision changes {decisionLogs.length > 200 ? "(capped at 200 on-screen)" : ""} | True: <strong style={{ color: "#22c55e" }}>{decisionLogs.filter((d) => d.label === "True").length}</strong> | False: <strong style={{ color: "#ef4444" }}>{decisionLogs.filter((d) => d.label === "False").length}</strong> | Missed: <strong style={{ color: "#eab308" }}>{decisionLogs.filter((d) => d.label === "missed" || d.label === "Missed").length}</strong> | Unlabeled: <strong>{decisionLogs.filter((d) => !d.label).length}</strong>
            </div>
          </div>
          <div style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
            <select
              value={decisionFilter}
              onChange={(e) => setDecisionFilter(e.target.value as "all" | "alerted" | "suppressed")}
              style={{ background: "#27272a", color: "#fff", border: "1px solid #3f3f46", padding: "4px 8px", borderRadius: "4px", fontSize: "0.75rem" }}
            >
              <option value="all">All Decisions</option>
              <option value="alerted">Alerted Only</option>
              <option value="suppressed">Suppressed Only</option>
            </select>
            <button
              onClick={handleOpenMissedModal}
              disabled={!isLoadedData || isEvaluatingClip}
              style={{
                padding: "4px 8px",
                background: !isLoadedData || isEvaluatingClip ? "#3f3f46" : "#27272a",
                border: "1px solid #eab308",
                color: "#eab308",
                borderRadius: "4px",
                fontSize: "0.75rem",
                cursor: !isLoadedData || isEvaluatingClip ? "not-allowed" : "pointer",
                fontWeight: "bold",
              }}
            >
              + Mark Missed
            </button>
            <button
              onClick={exportDecisionsCsv}
              disabled={decisionLogs.length === 0}
              style={{
                padding: "4px 10px",
                background: decisionLogs.length === 0 ? "#3f3f46" : "#2563eb",
                border: "none",
                color: "#ffffff",
                borderRadius: "4px",
                fontSize: "0.75rem",
                fontWeight: "bold",
                cursor: decisionLogs.length === 0 ? "not-allowed" : "pointer",
              }}
            >
              Export CSV
            </button>
            <button
              onClick={() => setDecisionLogs([])}
              style={{
                padding: "4px 8px",
                background: "#27272a",
                border: "1px solid #3f3f46",
                color: "#a1a1aa",
                borderRadius: "4px",
                fontSize: "0.75rem",
                cursor: "pointer",
              }}
            >
              Clear
            </button>
          </div>
        </div>

        {decisionLogs.length === 0 ? (
          <p style={{ color: "#71717a", fontSize: "0.8rem", margin: 0 }}>
            No object decisions recorded yet. Run clip evaluation or play sampler to stream frame decisions.
          </p>
        ) : (
          <div style={{ maxHeight: "320px", overflowY: "auto", fontSize: "0.75rem" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left" }}>
              <thead>
                <tr style={{ color: "#a1a1aa", borderBottom: "1px solid #27272a" }}>
                  <th style={{ padding: "4px 6px" }}>t (s)</th>
                  <th style={{ padding: "4px 6px" }}>Class</th>
                  <th style={{ padding: "4px 6px" }}>Dir</th>
                  <th style={{ padding: "4px 6px" }}>Decision</th>
                  <th style={{ padding: "4px 6px" }}>Reason</th>
                  <th style={{ padding: "4px 6px", textAlign: "center" }}>Label Annotation</th>
                </tr>
              </thead>
              <tbody>
                {decisionLogs
                  .filter((d) => {
                    if (decisionFilter === "alerted") return d.decision === "alerted";
                    if (decisionFilter === "suppressed") return d.decision.startsWith("suppressed");
                    return true;
                  })
                  .slice(0, 200)
                  .map((d) => (
                    <tr key={d.id} style={{ borderBottom: "1px solid #27272a" }}>
                      <td style={{ padding: "4px 6px", color: "#38bdf8" }}>{d.t.toFixed(2)}s</td>
                      <td style={{ padding: "4px 6px", fontWeight: "bold" }}>{d.class}</td>
                      <td style={{ padding: "4px 6px" }}>{d.direction}</td>
                      <td style={{ padding: "4px 6px" }}>
                        <span
                          style={{
                            padding: "2px 6px",
                            borderRadius: "3px",
                            fontWeight: "bold",
                            fontSize: "0.7rem",
                            background:
                              d.decision === "alerted"
                                ? "#15803d"
                                : d.decision === "missed_hazard"
                                ? "#a16207"
                                : "#3f3f46",
                            color: d.decision === "alerted" || d.decision === "missed_hazard" ? "#ffffff" : "#d4d4d8",
                          }}
                        >
                          {d.decision}
                        </span>
                      </td>
                      <td style={{ padding: "4px 6px", fontFamily: "monospace", color: "#a1a1aa" }}>{d.reason}</td>
                      <td style={{ padding: "4px 6px", textAlign: "center" }}>
                        {d.decision === "alerted" ? (
                          <div style={{ display: "inline-flex", gap: "2px" }}>
                            <button
                              onClick={() => handleLabelDecision(d.id, "True")}
                              style={{
                                padding: "2px 8px",
                                fontSize: "0.68rem",
                                borderRadius: "3px",
                                border: "1px solid #22c55e",
                                background: d.label === "True" ? "#22c55e" : "#18181b",
                                color: d.label === "True" ? "#000" : "#22c55e",
                                fontWeight: d.label === "True" ? "bold" : "normal",
                                cursor: "pointer",
                              }}
                            >
                              True
                            </button>
                            <button
                              onClick={() => handleLabelDecision(d.id, "False")}
                              style={{
                                padding: "2px 8px",
                                fontSize: "0.68rem",
                                borderRadius: "3px",
                                border: "1px solid #ef4444",
                                background: d.label === "False" ? "#ef4444" : "#18181b",
                                color: d.label === "False" ? "#fff" : "#ef4444",
                                fontWeight: d.label === "False" ? "bold" : "normal",
                                cursor: "pointer",
                              }}
                            >
                              False
                            </button>
                          </div>
                        ) : d.label === "missed" || d.label === "Missed" ? (
                          <span
                            style={{
                              padding: "2px 6px",
                              borderRadius: "3px",
                              background: "#eab308",
                              color: "#000",
                              fontWeight: "bold",
                              fontSize: "0.7rem",
                            }}
                          >
                            Missed
                          </span>
                        ) : (
                          <span style={{ color: "#52525b", fontSize: "0.75rem" }}>&mdash;</span>
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
