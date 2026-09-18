import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { bundleAuthoredModuleForGeneration } from "#internal/authored-module-loader.js";

describe("self-modification authored runtime boundary", () => {
  it.each(["agent", "sandbox"])(
    "keeps runtime implementations out of the %s generation",
    async (entry) => {
      const code = await bundleAuthoredModuleForGeneration(
        fileURLToPath(new URL(`./extension/subagents/agent/${entry}.ts`, import.meta.url)),
      );

      expect(code).not.toContain("node-liblzma");
      expect(code).not.toContain("@mongodb-js/zstd");
      expect(code).not.toContain("createJustBashSandboxBackend");
      expect(code).not.toContain("loadJustBashModule");
      if (entry === "sandbox") {
        for (const specifier of [
          "eve/sandbox",
          "eve/sandbox/just-bash",
          "eve/sandbox/microsandbox",
          "eve/sandbox/vercel",
        ]) {
          expect(code).toContain(`from "${specifier}"`);
        }
      } else {
        expect(code).toContain('from "eve"');
      }
    },
  );
});
