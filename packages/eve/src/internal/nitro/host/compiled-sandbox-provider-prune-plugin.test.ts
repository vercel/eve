import { describe, expect, it } from "vitest";

import { createCompiledSandboxProviderPrunePlugin } from "./compiled-sandbox-provider-prune-plugin.js";

describe("createCompiledSandboxProviderPrunePlugin", () => {
  it("replaces local provider constructors with hosted stubs", () => {
    const plugin = createCompiledSandboxProviderPrunePlugin();
    const source = plugin.load?.("/repo/packages/eve/src/sandbox/providers/docker.ts");

    expect(source).toContain("DockerSandbox");
  });

  it.each(["docker.ts", "just-bash.ts", "local.js", "local.ts"])(
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
