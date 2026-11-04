import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Plugin, PluginContext, ResolvedId, ResolveIdExtraOptions } from "rolldown";
import { describe, expect, it } from "vitest";

import { normalizeEsmImportSpecifier } from "#internal/application/import-specifier.js";
import { resolvePackageDependencyPath } from "#internal/application/package.js";
import {
  createGenerationPackageBoundaryPlugin,
  createRuntimeLoaderPackageBoundaryPlugin,
} from "#internal/authored-package-boundary.js";

/** Calls a plugin's `resolveId` for a static import, with `resolve` as its context's resolver. */
async function resolveThrough(
  plugin: Plugin,
  resolve: PluginContext["resolve"],
  source: string,
  importer: string,
): Promise<unknown> {
  const hook = plugin.resolveId;
  if (typeof hook !== "function") throw new Error(`Plugin "${plugin.name}" has no resolveId.`);
  return await hook.call({ resolve } as PluginContext, source, importer, {
    kind: "import-statement",
  } as ResolveIdExtraOptions);
}

const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

describe("createGenerationPackageBoundaryPlugin", () => {
  it("keeps eve imports portable", async () => {
    const plugin = createGenerationPackageBoundaryPlugin({
      externalDependencies: [],
      packageRoot: PACKAGE_ROOT,
    });
    const resolve: PluginContext["resolve"] = async () => {
      throw new Error("framework imports should resolve before delegating");
    };

    await expect(
      resolveThrough(plugin, resolve, "eve/tools", join(PACKAGE_ROOT, "agent/tools/probe.ts")),
    ).resolves.toEqual({ external: true, id: "eve/tools" });
    for (const specifier of [
      "eve/self-modification",
      "eve/extensions/self-modification/local",
      "eve/extensions/self-modification/remote",
    ]) {
      await expect(
        resolveThrough(plugin, resolve, specifier, join(PACKAGE_ROOT, "agent/extensions/edit.ts")),
      ).resolves.toBeUndefined();
    }
  });

  it("resolves package-private imports from the importing dependency", async () => {
    const plugin = createGenerationPackageBoundaryPlugin({
      externalDependencies: [],
      packageRoot: join(PACKAGE_ROOT, "test/consumer-app"),
    });
    const resolve: PluginContext["resolve"] = async () => {
      throw new Error("package imports should resolve before delegating");
    };

    await expect(
      resolveThrough(
        plugin,
        resolve,
        "#shared/git.js",
        join(PACKAGE_ROOT, "dist/src/self-modification/extension/subagents/agent/agent.js"),
      ),
    ).resolves.toEqual({
      id: join(PACKAGE_ROOT, "dist/src/shared/git.js"),
    });
  });
});

describe("createRuntimeLoaderPackageBoundaryPlugin", () => {
  it("binds eve imports to the executing framework installation", async () => {
    const plugin = createRuntimeLoaderPackageBoundaryPlugin({
      externalDependencies: [],
      packageRoot: PACKAGE_ROOT,
    });
    const resolve: PluginContext["resolve"] = async () => {
      throw new Error("framework imports should resolve before delegating");
    };

    await expect(
      resolveThrough(
        plugin,
        resolve,
        "eve/tools",
        join(
          PACKAGE_ROOT,
          "dist/src/self-modification/extension/subagents/agent/tools/edit_file.js",
        ),
      ),
    ).resolves.toEqual({
      external: true,
      id: resolvePackageDependencyPath("eve/tools"),
    });
  });

  it("binds eve package imports to the published dist modules", async () => {
    const plugin = createRuntimeLoaderPackageBoundaryPlugin({
      externalDependencies: [],
      packageRoot: PACKAGE_ROOT,
    });
    const resolve: PluginContext["resolve"] = async () => {
      throw new Error("package imports should resolve before delegating");
    };

    await expect(
      resolveThrough(
        plugin,
        resolve,
        "#shared/git.js",
        join(PACKAGE_ROOT, "dist/src/self-modification/extension/subagents/agent/agent.js"),
      ),
    ).resolves.toEqual({
      external: true,
      id: normalizeEsmImportSpecifier(join(PACKAGE_ROOT, "dist/src/shared/git.js")),
    });
  });

  it.each([
    [
      "C:\\workspace\\app\\node_modules\\external-only\\index.js",
      "file:///C:/workspace/app/node_modules/external-only/index.js",
    ],
    [
      "\\\\server\\share\\app\\node_modules\\external-only\\index.js",
      "file://server/share/app/node_modules/external-only/index.js",
    ],
    [
      "/workspace/app/node_modules/external-only/index.js",
      "/workspace/app/node_modules/external-only/index.js",
    ],
    ["external-only", "external-only"],
  ])("emits resolved external %s as %s", async (resolvedId, expectedId) => {
    const plugin = createRuntimeLoaderPackageBoundaryPlugin({
      externalDependencies: ["external-only"],
      packageRoot: "C:\\workspace\\app",
    });
    const resolve: PluginContext["resolve"] = async () => {
      return { id: resolvedId } as ResolvedId;
    };

    await expect(
      resolveThrough(plugin, resolve, "external-only", "C:\\workspace\\app\\agent\\tools\\ping.ts"),
    ).resolves.toEqual({
      external: true,
      id: expectedId,
    });
  });
});
