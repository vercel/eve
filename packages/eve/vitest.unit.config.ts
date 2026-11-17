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
    env: { EVE_CHECK_SESSION_EVENTS: "1" },
    environment: "node",
    exclude: [
      "**/node_modules/**",
      "src/**/*.integration.test.ts",
      "src/**/*.scenario.test.ts",
      "test/**/*.integration.test.ts",
      "test/browser/**",
      "test/framework-fixtures/**",
      "test/scenarios/**",
    ],
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    setupFiles: ["./src/internal/testing/unit-guard.ts", "./test/setup/mock-ai-gateway.ts"],
    testTimeout: 5_000,
  },
});
