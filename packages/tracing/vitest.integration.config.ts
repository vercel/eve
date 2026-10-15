import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["eve-source"] },
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
  },
});
