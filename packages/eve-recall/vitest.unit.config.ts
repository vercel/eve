import { defineConfig } from "vitest/config";

// The channel's session behavior runs in eve's harness, from packages/eve/test/channels/recall.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
