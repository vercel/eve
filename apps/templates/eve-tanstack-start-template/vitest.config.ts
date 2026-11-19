import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/web/app/**/*.test.ts"],
    restoreMocks: true,
  },
});
