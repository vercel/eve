import { describe, expect, it } from "vitest";

import type { ExternalsPolicy } from "#internal/nitro/host/externals-policy.js";
import { createHostedGraphPlugin } from "#internal/nitro/host/hosted-graph-plugin.js";
import { callPluginHook } from "#internal/testing/plugin-hooks.js";

const NO_EXTERNALS: ExternalsPolicy = {
  checkedExternals: [],
  pruneDevelopmentRuntime: false,
  pruneSandboxProviders: false,
  traceDeps: [],
  untracedExternals: [],
};

function hostedGraph(externals: Partial<ExternalsPolicy>) {
  const plugin = createHostedGraphPlugin({
    appRoot: "/app",
    externals: { ...NO_EXTERNALS, ...externals },
  });
  if (plugin === null) throw new Error("Expected a hosted graph plugin.");
  return plugin;
}

/** Resolves `source` and loads the module it resolves to. */
async function loadResolved(plugin: object, source: string): Promise<unknown> {
  const resolved = await callPluginHook(plugin, "resolveId", source, undefined);
  if (typeof resolved !== "string") throw new Error(`Expected ${source} to be substituted.`);
  return await callPluginHook(plugin, "load", resolved);
}

describe("createHostedGraphPlugin", () => {
  it("stubs development-only sandbox preparation and its engine installer", async () => {
    const plugin = hostedGraph({ pruneDevelopmentRuntime: true });

    for (const source of [
      "/repo/packages/eve/dist/src/execution/sandbox/development-lazy-prewarm.js",
      "/repo/packages/eve/src/execution/sandbox/development-lazy-prewarm.ts?query",
      "#execution/sandbox/development-lazy-prewarm.js",
    ]) {
      expect(await loadResolved(plugin, source)).toBe(
        "export async function ensureDevelopmentSandboxesPrepared() {}\n",
      );
    }
    for (const source of [
      "/repo/packages/eve/dist/src/internal/application/optional-package-install.js",
      "#internal/application/optional-package-install.js",
    ]) {
      expect(await loadResolved(plugin, source)).toContain(
        "export const loadOptionalEnginePackage = pruned;",
      );
    }
  });

  it.each(["docker.ts", "just-bash.ts", "local.js", "local.ts"])(
    "stubs the local sandbox binding %s with every export of the local facade",
    async (fileName) => {
      const source = await loadResolved(
        hostedGraph({ pruneSandboxProviders: true }),
        `/repo/packages/eve/dist/src/execution/sandbox/bindings/${fileName}`,
      );

      expect(source).toContain("export const isLinuxDockerDaemonAvailableSync = () => false;");
      expect(source).toContain("export const stopDevelopmentSandboxResources = pruned;");
    },
  );

  it("stubs local sandbox provider constructors reached by path", async () => {
    const plugin = hostedGraph({ pruneSandboxProviders: true });

    expect(
      await callPluginHook(plugin, "load", "/repo/packages/eve/src/sandbox/providers/docker.ts"),
    ).toContain("DockerSandbox");
  });

  it("keeps unconfigured optional engines as plain externals and leaves other packages alone", async () => {
    const plugin = hostedGraph({ untracedExternals: ["just-bash"] });

    expect(await callPluginHook(plugin, "resolveId", "just-bash", undefined)).toEqual({
      external: true,
      id: "just-bash",
    });
    expect(await callPluginHook(plugin, "resolveId", "just-bash/browser", undefined)).toBeNull();
    expect(await callPluginHook(plugin, "resolveId", "zod", undefined)).toBeNull();
  });

  it("applies only the substitutions the policy enables", async () => {
    const plugin = hostedGraph({ untracedExternals: ["just-bash"] });

    expect(
      await callPluginHook(
        plugin,
        "resolveId",
        "#execution/sandbox/development-lazy-prewarm.js",
        undefined,
      ),
    ).toBeNull();
    expect(
      await callPluginHook(
        plugin,
        "resolveId",
        "/repo/packages/eve/dist/src/execution/sandbox/bindings/local.js",
        undefined,
      ),
    ).toBeNull();
  });
});
