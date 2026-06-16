import { defineConfig } from "vitest/config";

import { workflow } from "./src/internal/testing/workflow-vitest-plugin.js";

/**
 * Tier 1 — Integration tests.
 *
 * Tests that exercise multiple eve modules together — typically through the
 * workflow SDK, the compiler, the discover pipeline, or the nitro routes —
 * without spawning subprocesses, binding real TCP ports, or shelling out to
 * the `eve` CLI. These tests may touch the filesystem (tmpdirs, generated
 * fixtures) and currently invoke the real compile pipeline while the
 * in-memory `AppHarness` (phase D) is under construction.
 *
 * If a test needs a subprocess, a real HTTP listener, or a real package
 * tarball install, move it to the scenario tier
 * (`test/scenarios/*.scenario.test.ts`).
 */
export default defineConfig({
  plugins: [workflow()],
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
    exclude: ["**/node_modules/**", "test/scenarios/**", "test/vercel/**"],
    globalSetup: ["./test/setup/clear-workflow-cache.ts"],
    include: ["src/**/*.integration.test.ts", "test/**/*.integration.test.ts"],
    setupFiles: ["./test/setup/mock-ai-gateway.ts"],
    testTimeout: 30_000,
  },
});
