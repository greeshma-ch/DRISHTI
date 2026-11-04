import "@testing-library/jest-dom";
import { vi } from "vitest";
import { act } from "react";

// Make act globally available for tests
(globalThis as any).act = act;

// Polyfill for React 19 + jsdom
// See: https://github.com/facebook/react/issues/25573
// jsdom doesn't implement addEventListener on all elements properly

// Ensure window.matchMedia is available
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

// Ensure ResizeObserver is available
if (typeof window !== "undefined" && !window.ResizeObserver) {
  window.ResizeObserver = vi.fn().mockImplementation(() => ({
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  }));
}
