import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["{api,lib}/**/*.test.mjs"] } });
