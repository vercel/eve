import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^#compiled\/(.+)\.js$/,
        replacement: fileURLToPath(new URL("./.generated/compiled/$1.js", import.meta.url)),
      },
      {
        find: /^#(.+)\.js$/,
        replacement: fileURLToPath(new URL("./src/$1.ts", import.meta.url)),
      },
    ],
  },
  test: {
    environment: "node",
    exclude: ["**/node_modules/**", "test/vercel/**"],
    globalSetup: ["./test/setup/pack-scenario-tarball.ts"],
    include: ["**/dev-server.scenario.test.ts"],
    setupFiles: ["./test/setup/mock-ai-gateway.ts"],
    testTimeout: 360_000,
  },
});
