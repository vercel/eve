import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { discoverExtensionMountDeclarations } from "#discover/discover-agent.js";
import { locateExtensionMountPackage } from "#discover/extensions.js";
import { createDiskProjectSource } from "#discover/project-source.js";
import { resolveDiscoveryProject } from "#discover/project.js";
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

import { prepareDevelopmentWorkspaceExtensions } from "#internal/nitro/host/dev-workspace-extensions.js";

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
