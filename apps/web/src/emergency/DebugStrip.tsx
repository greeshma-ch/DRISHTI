/** Debug Strip (P6) — shows pointer events when ?debug=1 is in URL. */

import { useEffect, useState } from "react";

interface DebugEvent {
  type: string;
  target: string;
  x: number;
  y: number;
  time: number;
}

interface OverflowElement {
  tag: string;
  className: string;
  width: number;
  right: number;
  innerWidth: number;
}

/**
 * Full-width debug strip at top of screen showing pointer events.
 * Only renders when URL contains ?debug=1 or &debug=1.
 * Also detects and lists elements that overflow the viewport.
 */
export function DebugStrip() {
  const [events, setEvents] = useState<DebugEvent[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [overflowElements, setOverflowElements] = useState<OverflowElement[]>([]);

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const debugMode = urlParams.get("debug") === "1";
    setEnabled(debugMode);

    if (!debugMode) return;

    const handlePointer = (e: PointerEvent) => {
      const event: DebugEvent = {
        type: e.type,
        target: (e.target as HTMLElement)?.tagName || "unknown",
        x: Math.round(e.clientX),
        y: Math.round(e.clientY),
        time: Date.now(),
      };
      setEvents((prev) => [...prev.slice(-9), event]); // Keep last 10 events
    };

    const handleTouch = (e: TouchEvent) => {
      const touch = e.touches[0] || e.changedTouches[0];
      if (!touch) return;
      const event: DebugEvent = {
        type: e.type,
        target: (e.target as HTMLElement)?.tagName || "unknown",
        x: Math.round(touch.clientX),
        y: Math.round(touch.clientY),
        time: Date.now(),
      };
      setEvents((prev) => [...prev.slice(-9), event]);
    };

    // Listen for all pointer events on document
    document.addEventListener("pointerdown", handlePointer, true);
    document.addEventListener("pointerup", handlePointer, true);
    document.addEventListener("pointermove", handlePointer, true);
    document.addEventListener("touchstart", handleTouch, true);
    document.addEventListener("touchend", handleTouch, true);
    document.addEventListener("touchmove", handleTouch, true);

    return () => {
      document.removeEventListener("pointerdown", handlePointer, true);
      document.removeEventListener("pointerup", handlePointer, true);
      document.removeEventListener("pointermove", handlePointer, true);
      document.removeEventListener("touchstart", handleTouch, true);
      document.removeEventListener("touchend", handleTouch, true);
      document.removeEventListener("touchmove", handleTouch, true);
    };
  }, []);

  // Check for overflow elements periodically when debug mode is on
  useEffect(() => {
    if (!enabled) return;

    const checkOverflow = () => {
      const innerWidth = window.innerWidth;
      const overflow: OverflowElement[] = [];

      // Check all elements for overflow
      const allElements = document.querySelectorAll("*");
      allElements.forEach((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.right > innerWidth + 1) { // Allow 1px tolerance
          overflow.push({
            tag: el.tagName.toLowerCase(),
            className: el.className || "(no class)",
            width: Math.round(rect.width),
            right: Math.round(rect.right),
            innerWidth,
          });
        }
      });

      setOverflowElements(overflow);
    };

    // Check on mount and periodically
    checkOverflow();
    const interval = setInterval(checkOverflow, 2000);

    return () => clearInterval(interval);
  }, [enabled]);

  if (!enabled) return null;

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 9999,
        background: "rgba(0, 0, 0, 0.95)",
        color: "#4ade80",
        fontFamily: "monospace",
        fontSize: "0.6rem",
        lineHeight: 1.3,
        padding: "4px 8px",
        borderBottom: "2px solid #4ade80",
        overflow: "hidden",
        maxHeight: "180px",
      }}
      aria-label="Debug events"
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        {/* Pointer events */}
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", borderBottom: "1px solid #4ade80", paddingBottom: "4px" }}>
          {events.map((e, i) => (
            <span
              key={i}
              style={{
                background: "rgba(74, 222, 128, 0.15)",
                padding: "2px 6px",
                borderRadius: "3px",
                border: "1px solid #4ade80",
                whiteSpace: "nowrap",
              }}
            >
              [{e.type}] {e.target} @({e.x},{e.y})
            </span>
          ))}
          {events.length === 0 && <span style={{ opacity: 0.5 }}>Waiting for pointer events...</span>}
        </div>

        {/* Viewport overflow detection */}
        <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
          <div style={{ color: "#facc15", fontWeight: "bold" }}>
            Viewport: {window.innerWidth}px × {window.innerHeight}px | Document scrollWidth: {document.documentElement.scrollWidth}px
            {document.documentElement.scrollWidth > window.innerWidth && " ⚠️ OVERFLOW"}
          </div>
          {overflowElements.length > 0 && (
            <div style={{ maxHeight: "100px", overflow: "auto" }}>
              {overflowElements.map((o, i) => (
                <div
                  key={i}
                  style={{
                    background: "rgba(250, 204, 21, 0.15)",
                    padding: "2px 6px",
                    borderRadius: "3px",
                    border: "1px solid #facc15",
                    whiteSpace: "nowrap",
                    color: "#facc15",
                  }}
                >
                  {o.tag}.{o.className}: width={o.width}px right={o.right}px (innerWidth={o.innerWidth}px)
                </div>
              ))}
            </div>
          )}
          {overflowElements.length === 0 && (
            <div style={{ color: "#4ade80", opacity: 0.7 }}>No overflowing elements detected.</div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Hook to check if debug mode is enabled */
export function useDebugMode(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    setEnabled(urlParams.get("debug") === "1");
  }, []);
  return enabled;
}