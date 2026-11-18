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
    environment: "node",
    globalSetup: ["./test/setup/clear-workflow-cache.ts"],
    include: ["test/browser/**/*.test.ts"],
    server: {
      deps: {
        external: [/\.workflow-vitest[\\/]/],
      },
    },
    setupFiles: ["./test/setup/mock-ai-gateway.ts"],
    testTimeout: 60_000,
  },
});
