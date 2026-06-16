import { mkdir, utimes, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { describe, expect, it } from "vitest";

import { COMPILE_METADATA_KIND, COMPILE_METADATA_VERSION } from "#compiler/artifacts.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";
import { resolveRuntimeCompiledArtifactsVersionedCacheKey } from "#runtime/cache-key.js";
import {
  createBundledRuntimeCompiledArtifactsSource,
  createDiskRuntimeCompiledArtifactsSource,
} from "#runtime/compiled-artifacts-source.js";
import { resolveRuntimeCompilerArtifactPaths } from "#runtime/loaders/artifact-paths.js";

const createScratchDirectory = useTemporaryDirectories();

describe("resolveRuntimeCompiledArtifactsVersionedCacheKey", () => {
  it("invalidates disk keys when compile metadata mtime changes", async () => {
    const appRoot = await createScratchDirectory("eve-cache-key-");

    const metadataPath = await writeCompileMetadata({
      appRoot,
      sourceGraphHash: "stable-source-graph-hash",
    });
    await utimes(metadataPath, new Date(1_000), new Date(1_000));

    const keyBefore = await resolveRuntimeCompiledArtifactsVersionedCacheKey(
      createDiskRuntimeCompiledArtifactsSource(appRoot),
    );

    await utimes(metadataPath, new Date(2_000), new Date(2_000));

    const keyAfter = await resolveRuntimeCompiledArtifactsVersionedCacheKey(
      createDiskRuntimeCompiledArtifactsSource(appRoot),
    );

    expect(keyBefore).toContain("stable-source-graph-hash");
    expect(keyAfter).toContain("stable-source-graph-hash");
    expect(keyAfter).not.toEqual(keyBefore);
  });

  it("falls back to mtime-only invalidation when sourceGraphHash is empty", async () => {
    const appRoot = await createScratchDirectory("eve-cache-key-");

    const metadataPath = await writeCompileMetadata({
      appRoot,
      sourceGraphHash: "",
    });
    await utimes(metadataPath, new Date(3_000), new Date(3_000));

    const key = await resolveRuntimeCompiledArtifactsVersionedCacheKey(
      createDiskRuntimeCompiledArtifactsSource(appRoot),
    );

    expect(key).toContain(`disk:${appRoot}:mtime-`);
  });

  it("returns stable source keys when compile metadata is unavailable", async () => {
    const appRoot = await createScratchDirectory("eve-cache-key-");

    await expect(
      resolveRuntimeCompiledArtifactsVersionedCacheKey(
        createDiskRuntimeCompiledArtifactsSource(appRoot),
      ),
    ).resolves.toEqual(`disk:${appRoot}`);
    await expect(
      resolveRuntimeCompiledArtifactsVersionedCacheKey(
        createBundledRuntimeCompiledArtifactsSource(),
      ),
    ).resolves.toEqual("bundled");
  });

  it("keeps authored-source disk keys separate from compiled disk keys", async () => {
    const appRoot = await createScratchDirectory("eve-cache-key-");
    const moduleMapLoaderPath = "/tmp/authored-module-map-loader.mjs";

    await expect(
      resolveRuntimeCompiledArtifactsVersionedCacheKey(
        createDiskRuntimeCompiledArtifactsSource(appRoot, {
          moduleMapLoaderPath,
        }),
      ),
    ).resolves.toEqual(`disk:${appRoot}:authored-source:${moduleMapLoaderPath}`);
  });
});

async function writeCompileMetadata(input: {
  appRoot: string;
  sourceGraphHash: string;
}): Promise<string> {
  const { compileMetadataPath } = resolveRuntimeCompilerArtifactPaths(input.appRoot);

  await mkdir(dirname(compileMetadataPath), {
    recursive: true,
  });
  await writeFile(
    compileMetadataPath,
    `${JSON.stringify(
      {
        compile: {
          moduleMap: {
            path: ".eve/compile/module-map.mjs",
            sha256: "module-map-hash",
          },
        },
        discovery: {
          diagnostics: {
            path: ".eve/discovery/diagnostics.json",
            sha256: "diagnostics-hash",
          },
          manifest: {
            path: ".eve/discovery/agent-discovery-manifest.json",
            sha256: "manifest-hash",
          },
          sourceGraphHash: input.sourceGraphHash,
          summary: {
            errors: 0,
            warnings: 0,
          },
        },
        generator: {
          name: "eve",
          version: "0.0.0-test",
        },
        kind: COMPILE_METADATA_KIND,
        status: "ready",
        version: COMPILE_METADATA_VERSION,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return compileMetadataPath;
}
