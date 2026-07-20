import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    conditions: ["browser"],
    alias: {
      $lib: fileURLToPath(new URL("./src/lib", import.meta.url)),
      "@earendil-works/pi-ai": fileURLToPath(new URL("./src/pi-ai-browser.ts", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: "./tests/setup.ts",
    include: ["tests/**/*.test.ts"],
    css: true,
    globals: true,
    restoreMocks: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html", "lcov"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.{ts,svelte}"],
      exclude: ["src/main.ts"],
      thresholds: {
        lines: 75,
        functions: 60,
        branches: 65,
        statements: 75,
      },
    },
  },
});
