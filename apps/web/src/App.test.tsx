import { describe, it, expect } from "vitest";
import ReactDOM from "react-dom/client";
import App from "./App";
import { buildPhrase } from "./phrases";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("App", () => {
  it("mounts cleanly with controls, debug overlay, durations and stale threshold", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = ReactDOM.createRoot(container);
    await act(async () => {
      root.render(<App />);
    });
    expect(container.textContent).toContain("Drishti");
    expect(container.textContent).toContain("Start Vision");
    expect(container.textContent).toContain("Debug Overlay");
    expect(container.textContent).toContain("Durations (ms):");
    expect(container.textContent).toContain("Stale Threshold:");
    expect(container.textContent).toContain("Dropped Stale:");
    expect(container.textContent).toContain("JPEG Size");
    expect(container.textContent).toContain("Utterances Queued");
    expect(container.textContent).toContain("Finish Reason:");
    expect(container.textContent).toContain("Output Tokens:");
    expect(container.textContent).toContain("Last Spoken (phrase table):");
    expect(container.textContent).not.toContain("Path clear");
    expect(container.textContent).not.toContain("रास्ता साफ़");
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  describe("buildPhrase", () => {
    it("gives specific phrase for chair center with and without clear_side", () => {
      // chair center, clear_side right -> "कुर्सी आगे, दाएँ हटें" / "Chair ahead, step right"
      expect(
        buildPhrase({ type: "chair", direction: "center", clear_side: "right" }, "hi")
      ).toBe("कुर्सी आगे, दाएँ हटें");
      expect(
        buildPhrase({ type: "chair", direction: "center", clear_side: "right" }, "en")
      ).toBe("Chair ahead, step right");

      // chair center, clear_side left
      expect(
        buildPhrase({ type: "chair", direction: "center", clear_side: "left" }, "hi")
      ).toBe("कुर्सी आगे, बाएँ हटें");
      expect(
        buildPhrase({ type: "chair", direction: "center", clear_side: "left" }, "en")
      ).toBe("Chair ahead, step left");

      // chair center, clear_side none
      expect(
        buildPhrase({ type: "chair", direction: "center", clear_side: "none" }, "hi")
      ).toBe("कुर्सी आगे");
      expect(
        buildPhrase({ type: "chair", direction: "center", clear_side: "none" }, "en")
      ).toBe("Chair ahead");
    });

    it("handles other with a label (speaks label ahead)", () => {
      expect(
        buildPhrase({ type: "other", direction: "center", label: "कार्ट" }, "hi")
      ).toBe("कार्ट आगे");
      expect(
        buildPhrase({ type: "other", direction: "center", label: "cart" }, "en")
      ).toBe("cart ahead");

      // With clear_side
      expect(
        buildPhrase(
          { type: "other", direction: "center", label: "कार्ट", clear_side: "right" },
          "hi"
        )
      ).toBe("कार्ट आगे, दाएँ हटें");
      expect(
        buildPhrase(
          { type: "other", direction: "center", label: "cart", clear_side: "right" },
          "en"
        )
      ).toBe("cart ahead, step right");
    });

    it("handles other without a label (falls back to generic hazard word)", () => {
      expect(
        buildPhrase({ type: "other", direction: "center", label: null }, "hi")
      ).toBe("खतरा आगे");
      expect(
        buildPhrase({ type: "other", direction: "center", label: null }, "en")
      ).toBe("Hazard ahead");

      // With clear_side
      expect(
        buildPhrase(
          { type: "other", direction: "center", label: null, clear_side: "right" },
          "hi"
        )
      ).toBe("खतरा आगे, दाएँ हटें");
      expect(
        buildPhrase(
          { type: "other", direction: "center", label: null, clear_side: "right" },
          "en"
        )
      ).toBe("Hazard ahead, step right");
    });

    it("never returns path clear or implies safety (Hard Rule 1)", () => {
      expect(buildPhrase(null, "en")).toBe("");
      expect(buildPhrase(null, "hi")).toBe("");
      expect(buildPhrase({ type: "" }, "en")).toBe("");
      expect(buildPhrase({ type: "other", label: "path clear" }, "en")).not.toBe("Path clear");
    });
  });
});
