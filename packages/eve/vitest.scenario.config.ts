import { defineConfig } from "vitest/config";

/**
 * Tier 2 — Scenario tests.
 *
 * End-to-end behaviour checks that require real subprocesses, real HTTP
 * listeners, real compile/bundle pipelines, or real workflow on-disk state.
 * Scenario tests take seconds to run and frequently mutate
 * `process.cwd`/`process.env`, so each file runs in its own forked worker
 * process to guarantee isolation. Tests within a single file still run
 * sequentially.
 *
 * Nothing in this tier is expected to be hermetic. Keep the set small —
 * anything that can be expressed through the in-memory `AppHarness` belongs
 * in the integration tier instead.
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
    exclude: ["**/node_modules/**", "test/vercel/**"],
    globalSetup: ["./test/setup/pack-scenario-tarball.ts"],
    include: ["src/**/*.scenario.test.ts", "test/scenarios/**/*.scenario.test.ts"],
    setupFiles: ["./test/setup/mock-ai-gateway.ts"],
    testTimeout: 120_000,
  },
});
