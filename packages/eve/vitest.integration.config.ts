import { defineConfig } from "vitest/config";

import { workflow } from "./src/internal/testing/workflow-vitest-plugin.js";

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
    env: { EVE_CHECK_SESSION_EVENTS: "1" },
    environment: "node",
    exclude: [
      "**/node_modules/**",
      "test/scenarios/**",
      ...(process.platform === "win32" ? ["**/conformance*.integration.test.ts"] : []),
    ],
    globalSetup: ["./test/setup/clear-workflow-cache.ts"],
    include: ["src/**/*.integration.test.ts", "test/**/*.integration.test.ts"],
    server: {
      deps: {
        inline: [/@beeper\/chat-adapter-matrix/u],
      },
    },
    setupFiles: ["./test/setup/mock-ai-gateway.ts"],
    testTimeout: 30_000,
  },
});
