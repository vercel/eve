import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EXTENSION_COMPATIBILITY_MANIFEST_FILENAME,
  EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION,
  EXTENSION_COMPATIBILITY_MANIFEST_KIND,
  writeExtensionCompatibilityManifest,
} from "#compiler/extension-compatibility.js";
import { discoverExtensionMountDeclarations } from "#discover/discover-agent.js";
import { locateExtensionMountPackage } from "#discover/extensions.js";
import { createDiskProjectSource } from "#discover/project-source.js";
import { resolveDiscoveryProject } from "#discover/project.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import {
  isAuthoredSourcePath,
  resolveDevelopmentSourceRoot,
} from "#internal/nitro/dev-runtime-source-snapshot.js";
import { tryReadExtensionBuildConfig } from "#internal/nitro/host/build-extension.js";

const mocks = vi.hoisted(() => ({
  buildExtensionPackage: vi.fn(async () => undefined),
}));

vi.mock("#internal/nitro/host/build-extension.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#internal/nitro/host/build-extension.js")>()),
  buildExtensionPackage: mocks.buildExtensionPackage,
}));

import {
  buildWorkspaceExtensions,
  prepareDevelopmentWorkspaceExtensions,
} from "#internal/nitro/host/workspace-extensions.js";

const temporaryDirectories: string[] = [];

beforeEach(() => {
  mocks.buildExtensionPackage.mockClear();
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (path) => await rm(path, { force: true, recursive: true })),
  );
});

describe("prepareDevelopmentWorkspaceExtensions", () => {
  it("builds initial mounts and only rebuilds the extension affected by a source edit", async () => {
    const appRoot = await createWorkspaceAgent(["alpha", "beta"]);

    const mounts = await discoverExtensionMountDeclarations({
      agentRoot: join(appRoot, "agent"),
    });
    await expect(resolveDiscoveryProject(appRoot)).resolves.toMatchObject({
      agentRoot: join(appRoot, "agent"),
      appRoot,
    });
    expect(mounts.diagnostics).toEqual([]);
    expect(mounts.mounts).toHaveLength(2);
    const located = await locateExtensionMountPackage({
      source: createDiskProjectSource(),
      agentRoot: join(appRoot, "agent"),
      appRoot,
      mount: mounts.mounts[0]!.mountRef,
      namespace: mounts.mounts[0]!.namespace,
    });
    expect(located.diagnostics).toEqual([]);
    expect(located.location?.authoredSourceRoot).toBe(
      join(appRoot, "packages", "alpha", "extension"),
    );
    expect(
      isAuthoredSourcePath(
        join(appRoot, "packages", "alpha"),
        resolveDevelopmentSourceRoot(appRoot),
      ),
    ).toBe(true);
    await expect(
      tryReadExtensionBuildConfig(join(appRoot, "packages", "alpha")),
    ).resolves.not.toBeNull();

    const initial = await prepareDevelopmentWorkspaceExtensions({ appRoot });
    expect(initial).toHaveLength(2);
    expect(mocks.buildExtensionPackage).toHaveBeenCalledTimes(2);

    mocks.buildExtensionPackage.mockClear();
    const alphaSourcePath = join(appRoot, "packages", "alpha", "extension", "tools", "marker.ts");
    const next = await prepareDevelopmentWorkspaceExtensions({
      appRoot,
      changedPaths: [alphaSourcePath],
      previousExtensions: initial,
    });

    expect(next).toHaveLength(2);
    expect(mocks.buildExtensionPackage).toHaveBeenCalledOnce();
    expect(mocks.buildExtensionPackage).toHaveBeenCalledWith(
      join(appRoot, "packages", "alpha"),
      expect.objectContaining({ packageName: "@acme/alpha" }),
    );
  });

  it("builds workspace extensions mounted by local subagents", async () => {
    const appRoot = await createWorkspaceAgent(["alpha"]);
    await rm(join(appRoot, "agent", "extensions", "alpha.ts"));
    await writeText(
      join(appRoot, "agent", "subagents", "researcher", "extensions", "alpha.ts"),
      'export { default } from "../../../../packages/alpha";\n',
    );

    const extensions = await prepareDevelopmentWorkspaceExtensions({ appRoot });

    expect(extensions).toHaveLength(1);
    expect(mocks.buildExtensionPackage).toHaveBeenCalledOnce();
    expect(mocks.buildExtensionPackage).toHaveBeenCalledWith(
      join(appRoot, "packages", "alpha"),
      expect.objectContaining({ packageName: "@acme/alpha" }),
    );
  });

  it("does not rebuild an extension for an unrelated workspace dependency edit", async () => {
    const appRoot = await createWorkspaceAgent(["alpha"]);
    const initial = await prepareDevelopmentWorkspaceExtensions({ appRoot });
    mocks.buildExtensionPackage.mockClear();

    await prepareDevelopmentWorkspaceExtensions({
      appRoot,
      changedPaths: [join(appRoot, "packages", "shared", "src", "index.ts")],
      previousExtensions: initial,
    });

    expect(mocks.buildExtensionPackage).not.toHaveBeenCalled();
  });

  it("does not build a source-backed package installed inside node_modules", async () => {
    const appRoot = await createWorkspaceAgent([]);
    const installedRoot = join(appRoot, "node_modules", "@acme", "installed");
    await writeText(
      join(appRoot, "agent", "extensions", "installed.ts"),
      'export { default } from "@acme/installed";\n',
    );
    await writeText(
      join(installedRoot, "package.json"),
      `${JSON.stringify({
        name: "@acme/installed",
        type: "module",
        eve: { extension: { source: "extension", dist: "dist/extension" } },
      })}\n`,
    );
    await writeText(join(installedRoot, "extension", "extension.ts"), "export default {};\n");

    const extensions = await prepareDevelopmentWorkspaceExtensions({ appRoot });

    expect(extensions).toEqual([]);
    expect(mocks.buildExtensionPackage).not.toHaveBeenCalled();
  });

  it("does not rebuild a workspace package distributed without its authored source", async () => {
    const appRoot = await createWorkspaceAgent(["alpha"]);
    const packageRoot = join(appRoot, "packages", "alpha");
    await writeText(
      join(packageRoot, "dist", "extension", "extension.mjs"),
      "export default {};\n",
    );
    await rm(join(packageRoot, "extension"), { recursive: true });

    const extensions = await prepareDevelopmentWorkspaceExtensions({ appRoot });

    expect(extensions).toEqual([]);
    expect(mocks.buildExtensionPackage).not.toHaveBeenCalled();
  });

  it("rebuilds every mounted workspace extension for a forced reload", async () => {
    const appRoot = await createWorkspaceAgent(["alpha", "beta"]);
    const initial = await prepareDevelopmentWorkspaceExtensions({ appRoot });
    mocks.buildExtensionPackage.mockClear();

    await prepareDevelopmentWorkspaceExtensions({
      appRoot,
      changedPaths: [],
      previousExtensions: initial,
    });

    expect(mocks.buildExtensionPackage).toHaveBeenCalledTimes(2);
  });
});

describe("buildWorkspaceExtensions", () => {
  it("builds a mounted workspace extension whose distribution is missing", async () => {
    const appRoot = await createWorkspaceAgent(["alpha"]);

    await buildWorkspaceExtensions(appRoot);

    expect(mocks.buildExtensionPackage).toHaveBeenCalledOnce();
    expect(mocks.buildExtensionPackage).toHaveBeenCalledWith(
      join(appRoot, "packages", "alpha"),
      expect.objectContaining({ packageName: "@acme/alpha" }),
    );
  });

  it("skips an extension whose distribution is newer than its build inputs", async () => {
    const appRoot = await createWorkspaceAgent(["alpha"]);
    await writeDistributionManifest(join(appRoot, "packages", "alpha"), { builtAt: FUTURE });

    await buildWorkspaceExtensions(appRoot);

    expect(mocks.buildExtensionPackage).not.toHaveBeenCalled();
  });

  it("rebuilds an extension edited after its distribution was built", async () => {
    const appRoot = await createWorkspaceAgent(["alpha"]);
    const packageRoot = join(appRoot, "packages", "alpha");
    await writeDistributionManifest(packageRoot, { builtAt: PAST });

    await buildWorkspaceExtensions(appRoot);

    expect(mocks.buildExtensionPackage).toHaveBeenCalledOnce();
  });

  it("rebuilds an extension distribution built by another eve version", async () => {
    const appRoot = await createWorkspaceAgent(["alpha"]);
    await writeDistributionManifest(join(appRoot, "packages", "alpha"), {
      builtAt: FUTURE,
      builtWithEve: "0.0.0-other",
    });

    await buildWorkspaceExtensions(appRoot);

    expect(mocks.buildExtensionPackage).toHaveBeenCalledOnce();
  });

  it("names the workspace extension and the command to run when its build fails", async () => {
    const appRoot = await createWorkspaceAgent(["alpha"]);
    mocks.buildExtensionPackage.mockRejectedValueOnce(new Error("tools/search.ts is invalid"));

    await expect(buildWorkspaceExtensions(appRoot)).rejects.toThrow(
      `Failed to build workspace extension "@acme/alpha" at ${join(appRoot, "packages", "alpha")}. Fix the error below, then rebuild the agent, or run \`eve extension build\` in that package directory to build it on its own.\ntools/search.ts is invalid`,
    );
  });
});

const PAST = new Date("2000-01-01T00:00:00Z");
const FUTURE = new Date(Date.now() + 60 * 60 * 1000);

async function writeDistributionManifest(
  packageRoot: string,
  input: { readonly builtAt: Date; readonly builtWithEve?: string },
): Promise<void> {
  const distRoot = join(packageRoot, "dist", "extension");
  await mkdir(distRoot, { recursive: true });
  await writeExtensionCompatibilityManifest(distRoot, {
    kind: EXTENSION_COMPATIBILITY_MANIFEST_KIND,
    formatVersion: EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION,
    builtWithEve: input.builtWithEve ?? resolveInstalledPackageInfo().version,
    requires: {},
  });
  const manifestPath = join(distRoot, EXTENSION_COMPATIBILITY_MANIFEST_FILENAME);
  await utimes(manifestPath, input.builtAt, input.builtAt);
}

async function createWorkspaceAgent(extensionNames: readonly string[]): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "eve-workspace-extension-dev-"));
  temporaryDirectories.push(appRoot);
  await writeText(join(appRoot, "package.json"), '{"name":"workspace-agent","type":"module"}\n');
  await writeText(join(appRoot, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  await writeText(join(appRoot, "agent", "instructions.md"), "Test agent.\n");

  for (const name of extensionNames) {
    const packageRoot = join(appRoot, "packages", name);
    await writeText(
      join(appRoot, "agent", "extensions", `${name}.ts`),
      `export { default } from "../../packages/${name}";\n`,
    );
    await writeText(
      join(packageRoot, "package.json"),
      `${JSON.stringify({
        name: `@acme/${name}`,
        type: "module",
        eve: { extension: { source: "extension", dist: "dist/extension" } },
      })}\n`,
    );
    await writeText(join(packageRoot, "extension", "extension.ts"), "export default {};\n");
  }

  return await realpath(appRoot);
}

async function writeText(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}
