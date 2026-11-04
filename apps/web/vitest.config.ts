import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    react({
      jsxRuntime: "automatic",
      jsxImportSource: "react",
      babel: {
        plugins: [],
      },
    }),
  ],
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "../../shared"),
      "@shared/*": path.resolve(__dirname, "../../shared"),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    resolve: {
      alias: {
        "@shared": path.resolve(__dirname, "../../shared"),
        "@shared/*": path.resolve(__dirname, "../../shared"),
      },
    },
    // Use development build for react-dom/test-utils to export act
    env: {
      NODE_ENV: "development",
    },
    // Use esbuild for transform to avoid dev JSX transform issues
    transformMode: {
      web: [/\.[jt]sx$/],
    },
  },
  // Force esbuild for tests
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
});