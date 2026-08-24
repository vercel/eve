import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { inspectWorkspaceResourceRoot } from "#shared/workspace-resource-identity.js";

describe("workspace resource filesystem identity", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((rootPath) => rm(rootPath, { recursive: true })),
    );
  });

  it("rejects a resource root that redirects through a symbolic link", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "eve-workspace-resource-"));
    temporaryRoots.push(rootPath);
    const externalPath = join(rootPath, "external");
    const linkedPath = join(rootPath, "linked");
    await mkdir(externalPath);
    await symlink(externalPath, linkedPath, "dir");

    await expect(inspectWorkspaceResourceRoot(linkedPath)).rejects.toThrow(
      /must be a physical directory/u,
    );
  });

  it("rejects a resources directory that redirects through a symbolic link", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "eve-workspace-resource-"));
    temporaryRoots.push(rootPath);
    const externalPath = join(rootPath, "external");
    const resourcesPath = join(rootPath, "workspace-resources");
    const nodePath = join(externalPath, "__root__");
    await mkdir(nodePath, { recursive: true });
    await symlink(externalPath, resourcesPath, "dir");

    await expect(
      inspectWorkspaceResourceRoot(join(resourcesPath, "__root__"), {
        resourcesRootPath: resourcesPath,
      }),
    ).rejects.toThrow(/must be a physical directory/u);
  });
});
