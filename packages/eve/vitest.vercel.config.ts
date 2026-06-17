import { defineConfig } from "vitest/config";

/**
 * Tier 3 — Vercel deployment tests.
 *
 * Tests that deploy to real infrastructure (Vercel) and exercise the public
 * shape of eve from outside the repository. These are the slowest and most
 * externally dependent tests in the suite. They run sequentially and are
 * expected to be gated by credentials provided from CI secrets.
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
    exclude: ["**/node_modules/**"],
    fileParallelism: false,
    globalSetup: ["./test/setup/pack-scenario-tarball.ts"],
    include: ["test/vercel/**/*.vercel.test.ts"],
    sequence: {
      concurrent: false,
    },
    setupFiles: ["./test/setup/mock-ai-gateway.ts"],
    testTimeout: 30 * 60_000,
  },
});
