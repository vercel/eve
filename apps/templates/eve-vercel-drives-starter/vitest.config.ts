import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    clearMocks: true,
    include: ["agent/**/*.test.ts", "scripts/**/*.test.ts"],
    mockReset: true,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
  },
});
