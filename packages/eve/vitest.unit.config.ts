import { defineConfig } from "vitest/config";

/**
 * Tier 0 — Unit tests.
 *
 * Fast, hermetic tests that exercise a single module (or a small set of
 * modules) with every external boundary stubbed via `vi.mock`. Tests loaded by
 * this config must not touch the real filesystem (writes), spawn processes,
 * mutate `process.env`/`process.cwd`, or make real network requests. The
 * `unit-guard.ts` setup file replaces these surfaces with throwing stubs so
 * violations surface as a loud error that points the author at the integration
 * or scenario tier.
 *
 * Default timeout is deliberately tight so accidental I/O or async hangs fail
 * fast.
 */
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^#compiled\/(.+)\.js$/,
        replacement: new URL("./.generated/compiled/$1.js", import.meta.url).pathname,
      },
      {
        find: /^#(.+)\.js$/,
        replacement: new URL("./src/$1.ts", import.meta.url).pathname,
      },
    ],
  },
  test: {
    environment: "node",
    exclude: [
      "**/node_modules/**",
      "src/**/*.integration.test.ts",
      "src/**/*.scenario.test.ts",
      "test/**/*.integration.test.ts",
      "test/scenarios/**",
      "test/vercel/**",
    ],
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    setupFiles: ["./src/internal/testing/unit-guard.ts", "./test/setup/mock-ai-gateway.ts"],
    testTimeout: 5_000,
  },
});
