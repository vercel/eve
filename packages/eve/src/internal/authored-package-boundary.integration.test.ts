import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Plugin, PluginContext, ResolvedId, ResolveIdExtraOptions } from "rolldown";
import { afterEach, describe, expect, it } from "vitest";

import { normalizeEsmImportSpecifier } from "#internal/application/import-specifier.js";
import { createGenerationPackageBoundaryPlugin } from "#internal/authored-package-boundary.js";

const scratchRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratchRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function createTempApp(prefix: string): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), prefix));
  scratchRoots.push(appRoot);
  await writeFile(join(appRoot, "package.json"), JSON.stringify({ name: "app" }));
  return appRoot;
}

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

async function installPackage(
  appRoot: string,
  name: string,
  manifest: Record<string, unknown>,
): Promise<string> {
  const root = join(appRoot, "node_modules", name);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name, ...manifest }));
  await writeFile(join(root, "index.js"), "");
  return join(root, "index.js");
}

describe("createGenerationPackageBoundaryPlugin host bundles", () => {
  it("keeps a package host-external when it only optionally depends on a traced dependency", async () => {
    const appRoot = await createTempApp("eve-optional-traced-");
    await installPackage(appRoot, "sharp", {});
    const nextEntry = await installPackage(appRoot, "next", {
      optionalDependencies: { sharp: "*" },
    });
    const plugin = createGenerationPackageBoundaryPlugin({
      externalDependencies: ["sharp"],
      packageRoot: appRoot,
      hostBundle: { tracedDependencies: ["sharp"], externalPackageRoots: new Set() },
    });
    const resolve: PluginContext["resolve"] = async (source) =>
      source === "next" ? ({ id: nextEntry } as ResolvedId) : null;

    await expect(
      resolveThrough(plugin, resolve, "next", join(appRoot, "agent/tools/ping.ts")),
    ).resolves.toEqual({
      external: true,
      id: normalizeEsmImportSpecifier(nextEntry),
    });
  });

  it("keeps a package host-external when it only declares a traced dependency as an optional peer", async () => {
    const appRoot = await createTempApp("eve-optional-peer-traced-");
    await installPackage(appRoot, "@opentelemetry/api", {});
    const nextEntry = await installPackage(appRoot, "next", {
      peerDependencies: { "@opentelemetry/api": "^1.0.0" },
      peerDependenciesMeta: { "@opentelemetry/api": { optional: true } },
    });
    const plugin = createGenerationPackageBoundaryPlugin({
      externalDependencies: ["@opentelemetry/api"],
      packageRoot: appRoot,
      hostBundle: {
        tracedDependencies: ["@opentelemetry/api"],
        externalPackageRoots: new Set(),
      },
    });
    const resolve: PluginContext["resolve"] = async (source) =>
      source === "next" ? ({ id: nextEntry } as ResolvedId) : null;

    await expect(
      resolveThrough(plugin, resolve, "next", join(appRoot, "agent/tools/ping.ts")),
    ).resolves.toEqual({
      external: true,
      id: normalizeEsmImportSpecifier(nextEntry),
    });
  });

  it("leaves a package to the bundle when it requires a traced dependency", async () => {
    const appRoot = await createTempApp("eve-required-traced-");
    await installPackage(appRoot, "sharp", {});
    const wrapperEntry = await installPackage(appRoot, "sharp-wrapper", {
      dependencies: { sharp: "*" },
    });
    const plugin = createGenerationPackageBoundaryPlugin({
      externalDependencies: ["sharp"],
      packageRoot: appRoot,
      hostBundle: { tracedDependencies: ["sharp"], externalPackageRoots: new Set() },
    });
    const resolve: PluginContext["resolve"] = async (source) =>
      source === "sharp-wrapper" ? ({ id: wrapperEntry } as ResolvedId) : null;

    await expect(
      resolveThrough(plugin, resolve, "sharp-wrapper", join(appRoot, "agent/tools/ping.ts")),
    ).resolves.toBeUndefined();
  });

  it("leaves a package to the bundle when it requires a traced peer dependency", async () => {
    const appRoot = await createTempApp("eve-required-peer-traced-");
    await installPackage(appRoot, "sharp", {});
    const wrapperEntry = await installPackage(appRoot, "sharp-peer-wrapper", {
      peerDependencies: { sharp: "*" },
    });
    const plugin = createGenerationPackageBoundaryPlugin({
      externalDependencies: ["sharp"],
      packageRoot: appRoot,
      hostBundle: { tracedDependencies: ["sharp"], externalPackageRoots: new Set() },
    });
    const resolve: PluginContext["resolve"] = async (source) =>
      source === "sharp-peer-wrapper" ? ({ id: wrapperEntry } as ResolvedId) : null;

    await expect(
      resolveThrough(plugin, resolve, "sharp-peer-wrapper", join(appRoot, "agent/tools/ping.ts")),
    ).resolves.toBeUndefined();
  });
});
