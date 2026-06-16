import { describe, expect, it } from "vitest";

import { createCompiledSandboxBackendPrunePlugin } from "./compiled-sandbox-backend-prune-plugin.js";

describe("createCompiledSandboxBackendPrunePlugin", () => {
  it("keeps the hosted local-backend stub aligned with the local facade exports", () => {
    const plugin = createCompiledSandboxBackendPrunePlugin();
    const resolved = plugin.resolveId?.(
      "/repo/packages/eve/dist/src/execution/sandbox/bindings/local.js",
      undefined,
    );
    if (resolved == null) {
      throw new Error("Expected local backend binding to resolve to the pruned stub.");
    }
    const id = typeof resolved === "object" ? resolved.id : resolved;

    const source = plugin.load?.(id);

    expect(source).toContain("export const stopDevelopmentSandboxResources = pruned;");
  });
});
