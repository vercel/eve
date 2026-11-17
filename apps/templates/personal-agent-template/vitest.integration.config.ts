import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./apps/web/app", import.meta.url)),
      "#eve": fileURLToPath(new URL("./lib", import.meta.url)),
    },
  },
  test: { include: ["tests/*.test.ts"], setupFiles: ["tests/setup.ts"] },
});
