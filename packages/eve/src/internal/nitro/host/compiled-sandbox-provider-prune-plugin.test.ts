import { describe, expect, it } from "vitest";

import { createCompiledSandboxProviderPrunePlugin } from "./compiled-sandbox-provider-prune-plugin.js";

describe("createCompiledSandboxProviderPrunePlugin", () => {
  it("replaces framework default selection with the hosted Vercel provider", () => {
    const plugin = createCompiledSandboxProviderPrunePlugin();
    const source = plugin.load?.("/repo/packages/eve/src/sandbox/providers/default.ts");

    expect(source).toContain("DefaultSandbox = VercelSandbox");
  });

  it("replaces local provider constructors with hosted stubs", () => {
    const plugin = createCompiledSandboxProviderPrunePlugin();
    const source = plugin.load?.("/repo/packages/eve/src/sandbox/providers/microsandbox.ts");

    expect(source).toContain("MicrosandboxSandbox");
  });

  it("removes OCI publication code from hosted runtime bundles", () => {
    const plugin = createCompiledSandboxProviderPrunePlugin();
    const resolved = plugin.resolveId?.(
      "/repo/packages/eve/src/execution/sandbox/bindings/oci-image-publisher.ts",
      undefined,
    );
    if (resolved == null) throw new Error("Expected OCI publisher to resolve to a runtime stub.");
    const id = typeof resolved === "object" ? resolved.id : resolved;

    expect(plugin.load?.(id)).toContain("createOciImagePublisher = pruned");
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
