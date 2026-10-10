import { defineConfig } from "vitest/config";

import { workflow } from "./src/internal/testing/workflow-vitest-plugin.js";

/**
 * Browser tests.
 *
 * Drives client templates' real React pages in headless Chromium against an
 * in-memory agent, like the integration tier, but over a real HTTP listener and
 * a real browser. These run in their own CI job inside the Playwright container
 * image, which ships Chromium. Locally, install it with
 * `pnpm --filter eve exec playwright-core install chromium-headless-shell`.
 * The first run also installs the Web Chat template's registry dependencies
 * into a temp directory outside the workspace, so it needs the npm registry.
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
    globalSetup: ["./test/setup/clear-workflow-cache.ts"],
    include: ["test/browser/**/*.test.ts"],
    setupFiles: ["./test/setup/mock-ai-gateway.ts"],
    testTimeout: 60_000,
  },
});
