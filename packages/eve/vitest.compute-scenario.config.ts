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
    include: ["src/compute/**/*.scenario.test.ts", "test/scenarios/compute-*.scenario.test.ts"],
    maxWorkers: 1,
    testTimeout: 120_000,
  },
});
