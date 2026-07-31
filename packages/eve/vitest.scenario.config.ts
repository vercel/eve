import { defineConfig } from "vitest/config";

/**
 * Tier 2 — Scenario tests.
 *
 * End-to-end behaviour checks that require real subprocesses, real HTTP
 * listeners, real compile/bundle pipelines, or real workflow on-disk state.
 * Scenario tests take seconds to run and frequently mutate
 * `process.cwd`/`process.env`, so each file runs in its own forked worker
 * process, and files run in parallel across workers.
 *
 * Parallel-safety invariants every scenario file must uphold:
 * - never rebuild or clean the shared workspace outputs (`dist/`,
 *   `.generated/`) at test time — the suite requires a prebuilt workspace,
 *   and `globalSetup` packs the eve tarball once (scripts disabled) before
 *   any worker forks, so every worker reads shared, immutable state;
 * - bind listeners to port 0 and write only under per-test temp roots
 *   (`useScenarioApp`, `useTemporaryAppRoots`).
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
    // Subprocess-heavy files (dev servers, real builds, installs) fan out
    // beyond their own worker; a fixed cap keeps timing-sensitive
    // assertions stable on large hosts and matches CI's 4 vCPUs.
    maxWorkers: 4,
    setupFiles: ["./test/setup/mock-ai-gateway.ts"],
    testTimeout: 120_000,
  },
});
