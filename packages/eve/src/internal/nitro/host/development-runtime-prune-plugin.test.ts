import { describe, expect, it } from "vitest";

import { createDevelopmentRuntimePrunePlugin } from "./development-runtime-prune-plugin.js";

describe("createDevelopmentRuntimePrunePlugin", () => {
  it("prunes lazy preparation from hosted JavaScript and TypeScript graphs", () => {
    const plugin = createDevelopmentRuntimePrunePlugin();
    for (const path of [
      "/repo/packages/eve/dist/src/execution/sandbox/development-lazy-prewarm.js",
      "/repo/packages/eve/src/execution/sandbox/development-lazy-prewarm.ts?query",
      "#execution/sandbox/development-lazy-prewarm.js",
    ]) {
      const id = plugin.resolveId?.(path);
      if (id === null || id === undefined) throw new Error("Expected a pruned module id.");
      expect(plugin.load?.(id)).toBe(
        "export async function ensureDevelopmentSandboxesPrepared() {}\n",
      );
    }
  });
});
