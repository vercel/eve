import { defineConfig } from "vitest/config";

/**
 * Framework fixture smoke builds.
 *
 * Builds the example apps under `apps/frameworks` against the workspace eve
 * dist. These run in their own CI job, apart from the scenario tier, and
 * require a prebuilt workspace (`pnpm build`).
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
    include: ["test/framework-fixtures/**/*.test.ts"],
    testTimeout: 300_000,
  },
});
