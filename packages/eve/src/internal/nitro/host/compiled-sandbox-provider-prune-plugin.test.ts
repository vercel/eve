import { describe, expect, it } from "vitest";

import { createCompiledSandboxProviderPrunePlugin } from "./compiled-sandbox-provider-prune-plugin.js";

describe("createCompiledSandboxProviderPrunePlugin", () => {
  it("replaces framework default selection with the hosted Vercel provider", () => {
    const plugin = createCompiledSandboxProviderPrunePlugin();
    const source = plugin.load?.("/repo/packages/eve/src/sandbox/providers/default.ts");

    expect(source).toContain('DefaultSandbox = { name: "default", environment }');
    expect(source).toContain("options.vercel");
    expect(source).toContain("prepare: options.prepare");
  });

  it("prunes lazy development preparation from hosted bundles", () => {
    const plugin = createCompiledSandboxProviderPrunePlugin();
    const resolved = plugin.resolveId?.(
      "/repo/packages/eve/dist/src/execution/sandbox/development-lazy-prewarm.js",
      undefined,
    );
    if (resolved == null) throw new Error("Expected lazy prewarm to resolve to a hosted stub.");
    const id = typeof resolved === "object" ? resolved.id : resolved;
    expect(plugin.load?.(id)).toBe(
      "export async function ensureDevelopmentSandboxesPrepared() {}\n",
    );
  });

  it("replaces local provider constructors with hosted stubs", () => {
    const plugin = createCompiledSandboxProviderPrunePlugin();
    const source = plugin.load?.("/repo/packages/eve/src/sandbox/providers/microsandbox.ts");

    expect(source).toContain("MicrosandboxSandbox");
  });

  it.each(["docker.ts", "just-bash.ts", "local.js", "local.ts", "microsandbox.ts"])(
    "keeps the hosted local-backend stub aligned for %s",
    (fileName) => {
      const plugin = createCompiledSandboxProviderPrunePlugin();
      const resolved = plugin.resolveId?.(
        `/repo/packages/eve/dist/src/execution/sandbox/bindings/${fileName}`,
        undefined,
      );
      if (resolved == null) {
        throw new Error("Expected local backend binding to resolve to the pruned stub.");
      }
      const id = typeof resolved === "object" ? resolved.id : resolved;

      const source = plugin.load?.(id);

      expect(source).toContain("export const isLinuxDockerDaemonAvailableSync = () => false;");
      expect(source).toContain("export const stopDevelopmentSandboxResources = pruned;");
    },
  );
});
