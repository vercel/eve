import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@vercel\/agent-runs$/,
        replacement: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
      },
      {
        find: /^@vercel\/agent-runs\/(delegation|otel|ai-sdk)$/,
        replacement: fileURLToPath(new URL("./src/$1.ts", import.meta.url)),
      },
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
  },
});
