import { defineConfig } from "vitest/config";

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
    globalSetup: ["./test/setup/pack-scenario-tarball.ts"],
    include: ["src/**/*.scenario.test.ts", "test/scenarios/**/*.scenario.test.ts"],
    maxWorkers: 4,
    setupFiles: ["./test/setup/mock-ai-gateway.ts"],
    testTimeout: 120_000,
  },
});
