import { describe, expect, it } from "vitest";

import { createCompiledSandboxProviderPrunePlugin } from "./local-sandbox-provider-prune-plugin.js";

describe("createCompiledSandboxProviderPrunePlugin", () => {
  it("keeps the hosted local-provider stub aligned with the local facade exports", () => {
    const plugin = createCompiledSandboxProviderPrunePlugin();
    const resolved = plugin.resolveId?.(
      "/repo/packages/eve/dist/src/execution/sandbox/bindings/local.js",
      undefined,
    );
    if (resolved == null) {
      throw new Error("Expected local provider binding to resolve to the pruned stub.");
    }
    const id = typeof resolved === "object" ? resolved.id : resolved;

    const source = plugin.load?.(id);

    expect(source).toContain("export const stopDevelopmentSandboxResources = pruned;");
  });
});
