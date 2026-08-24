import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compileAgent } from "#compiler/compile-agent.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";
import { resolveRuntimeCompiledArtifactsVersionedCacheKey } from "#runtime/cache-key.js";
import { createDiskRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { resolveRuntimeCompilerArtifactPaths } from "#runtime/loaders/artifact-paths.js";
import { LoadCompileMetadataError } from "#runtime/loaders/compile-metadata.js";

const createScratchDirectory = useTemporaryDirectories();

describe("resolveRuntimeCompiledArtifactsVersionedCacheKey", () => {
  it("uses content identity instead of commit-marker mtime", async () => {
    const appRoot = await createCompiledApp();
    const source = createDiskRuntimeCompiledArtifactsSource(appRoot);
    const metadataPath = resolveRuntimeCompilerArtifactPaths(appRoot).compileMetadataPath;
    await utimes(metadataPath, new Date(1_000), new Date(1_000));
    const before = await resolveRuntimeCompiledArtifactsVersionedCacheKey(source);

    await utimes(metadataPath, new Date(2_000), new Date(2_000));

    await expect(resolveRuntimeCompiledArtifactsVersionedCacheKey(source)).resolves.toBe(before);
  });

  it("changes when recompilation changes transitive authored semantics", async () => {
    const appRoot = await createCompiledApp();
    const source = createDiskRuntimeCompiledArtifactsSource(appRoot);
    const before = await resolveRuntimeCompiledArtifactsVersionedCacheKey(source);

    await writeFile(
      join(appRoot, "agent", "implementation.ts"),
      'export const value = "openai/gpt-5.4";\n',
    );
    await compileAgent({ startPath: appRoot });

    await expect(resolveRuntimeCompiledArtifactsVersionedCacheKey(source)).resolves.not.toBe(
      before,
    );
  });

  it("rejects unavailable artifact envelopes instead of inventing a fallback key", async () => {
    const appRoot = await createScratchDirectory("eve-cache-key-missing-");

    await expect(
      resolveRuntimeCompiledArtifactsVersionedCacheKey(
        createDiskRuntimeCompiledArtifactsSource(appRoot),
      ),
    ).rejects.toBeInstanceOf(LoadCompileMetadataError);
  });

  it("keeps authored-source and compiled-map keys in separate namespaces", async () => {
    const appRoot = await createCompiledApp();
    const moduleMapLoaderPath = "/tmp/authored-module-map-loader.mjs";
    const compiled = await resolveRuntimeCompiledArtifactsVersionedCacheKey(
      createDiskRuntimeCompiledArtifactsSource(appRoot),
    );
    const authored = await resolveRuntimeCompiledArtifactsVersionedCacheKey(
      createDiskRuntimeCompiledArtifactsSource(appRoot, {
        moduleMapLoaderKind: "authored-source",
        moduleMapLoaderPath,
      }),
    );

    expect(compiled).not.toBe(authored);
    expect(authored).toContain(`disk:${appRoot}:authored-source:${moduleMapLoaderPath}:`);
  });
});

async function createCompiledApp(): Promise<string> {
  const appRoot = await createScratchDirectory("eve-cache-key-");
  const agentRoot = join(appRoot, "agent");
  await mkdir(agentRoot, { recursive: true });
  await Promise.all([
    writeFile(join(appRoot, "package.json"), '{"name":"cache-key-fixture","type":"module"}\n'),
    writeFile(
      join(agentRoot, "agent.ts"),
      ['import { value } from "./implementation.js";', "export default { model: value };", ""].join(
        "\n",
      ),
    ),
    writeFile(
      join(agentRoot, "implementation.ts"),
      'export const value = "openai/gpt-5.4-mini";\n',
    ),
    writeFile(join(agentRoot, "instructions.md"), "Use the compiled cache identity.\n"),
  ]);
  await compileAgent({ startPath: appRoot });
  return appRoot;
}
