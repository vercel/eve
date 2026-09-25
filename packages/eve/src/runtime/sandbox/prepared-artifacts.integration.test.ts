import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createDiskRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { withBundledCompiledArtifacts } from "#runtime/loaders/bundled-artifacts.js";
import {
  loadSandboxPreparedArtifact,
  writeSandboxPreparedArtifactsManifest,
} from "#runtime/sandbox/prepared-artifacts.js";
import { createSandboxPreparedArtifactsManifest } from "#shared/sandbox-prepared-artifacts.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

const createScratchDirectory = useTemporaryDirectories();

describe("sandbox prepared artifacts", () => {
  it("writes and loads provider artifacts from disk", async () => {
    const appRoot = await createScratchDirectory("eve-sandbox-prepared-artifacts-");
    const compileDirectoryPath = join(appRoot, ".eve", "compile");
    await mkdir(compileDirectoryPath, { recursive: true });

    await writeSandboxPreparedArtifactsManifest({
      compileDirectoryPath,
      entries: [
        {
          artifact: { imageReference: "eve-template:v1" },
          nodeId: "__root__",
          providerName: "docker",
        },
      ],
    });

    await expect(
      loadSandboxPreparedArtifact({
        compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(appRoot),
        nodeId: "__root__",
        providerName: "docker",
      }),
    ).resolves.toEqual({ imageReference: "eve-template:v1" });
  });

  it("loads the same artifact from bundled runtime state", async () => {
    const sandboxPreparedArtifacts = createSandboxPreparedArtifactsManifest([
      {
        artifact: { snapshotId: "snap_123" },
        nodeId: "__root__",
        providerName: "vercel",
      },
    ]);

    await withBundledCompiledArtifacts(
      {
        manifest: {} as never,
        moduleMap: {} as never,
        sandboxPreparedArtifacts,
      },
      async () => {
        await expect(
          loadSandboxPreparedArtifact({
            compiledArtifactsSource: { kind: "bundled" },
            nodeId: "__root__",
            providerName: "vercel",
          }),
        ).resolves.toEqual({ snapshotId: "snap_123" });
      },
    );
  });
});
