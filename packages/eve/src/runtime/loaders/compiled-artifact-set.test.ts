import { describe, expect, it } from "vitest";

import { compileFromMemory } from "#compiler/compile-from-memory.js";
import { createAgentSourceManifest } from "#discover/manifest.js";
import { serializeArtifactJson } from "#protocol/artifact-json.js";
import { resolveRuntimeCompilerArtifactPaths } from "#runtime/loaders/artifact-paths.js";
import { readStableDiskCompiledArtifactSnapshot } from "#runtime/loaders/compiled-artifact-set.js";

describe("disk compiled artifact snapshots", () => {
  it("retries a coordinated rewrite instead of mixing revisions", async () => {
    const first = await createDiskSources("first");
    const second = await createDiskSources("second");
    const paths = resolveRuntimeCompilerArtifactPaths(first.appRoot);
    let metadataReads = 0;

    const snapshot = await readStableDiskCompiledArtifactSnapshot(first.appRoot, {
      async readFile(path) {
        if (path === paths.compileMetadataPath) {
          metadataReads += 1;
          return metadataReads === 1 ? first.metadata : second.metadata;
        }
        const revision = metadataReads === 1 ? first : second;
        if (path === paths.compiledManifestPath) return revision.manifest;
        if (path === paths.diagnosticsPath) return revision.diagnostics;
        if (path === paths.discoveryManifestPath) return revision.discovery;
        if (path === paths.moduleMapPath) return revision.moduleMap;
        throw new Error(`Unexpected artifact read: ${path}`);
      },
    });

    expect(metadataReads).toBe(4);
    expect(snapshot.manifest.config.name).toBe("second");
    expect(snapshot.metadata).toEqual(second.compiled.metadata);
  });

  it("waits for metadata to be republished after an in-flight payload publication", async () => {
    const revision = await createDiskSources("published");
    const paths = resolveRuntimeCompilerArtifactPaths(revision.appRoot);
    let metadataReads = 0;

    const snapshot = await readStableDiskCompiledArtifactSnapshot(revision.appRoot, {
      async readFile(path) {
        if (path === paths.compileMetadataPath) {
          metadataReads += 1;
          if (metadataReads <= 3) {
            throw Object.assign(new Error("metadata commit marker is absent"), { code: "ENOENT" });
          }
          return revision.metadata;
        }
        if (path === paths.compiledManifestPath) return revision.manifest;
        if (path === paths.diagnosticsPath) return revision.diagnostics;
        if (path === paths.discoveryManifestPath) return revision.discovery;
        if (path === paths.moduleMapPath) return revision.moduleMap;
        throw new Error(`Unexpected artifact read: ${path}`);
      },
    });

    expect(metadataReads).toBe(5);
    expect(snapshot.manifest.config.name).toBe("published");
  });

  it("retries an old marker observed with newly published payloads", async () => {
    const first = await createDiskSources("old");
    const second = await createDiskSources("new");
    const paths = resolveRuntimeCompilerArtifactPaths(first.appRoot);
    let metadataReads = 0;

    const snapshot = await readStableDiskCompiledArtifactSnapshot(first.appRoot, {
      async readFile(path) {
        if (path === paths.compileMetadataPath) {
          metadataReads += 1;
          return metadataReads <= 2 ? first.metadata : second.metadata;
        }
        if (path === paths.compiledManifestPath) return second.manifest;
        if (path === paths.diagnosticsPath) return second.diagnostics;
        if (path === paths.discoveryManifestPath) return second.discovery;
        if (path === paths.moduleMapPath) return second.moduleMap;
        throw new Error(`Unexpected artifact read: ${path}`);
      },
    });

    expect(metadataReads).toBe(4);
    expect(snapshot.manifest.config.name).toBe("new");
  });

  it("rejects malformed config provenance before hydrating a disk module map", async () => {
    const revision = await createDiskSources("malformed-config");
    const paths = resolveRuntimeCompilerArtifactPaths(revision.appRoot);
    const configSource = revision.compiled.manifest.config.source!;
    const malformedManifest = serialize({
      ...revision.compiled.manifest,
      config: {
        ...revision.compiled.manifest.config,
        source: { ...configSource, sourceId: "memory::missing-agent.ts" },
      },
    });

    await expect(
      readStableDiskCompiledArtifactSnapshot(revision.appRoot, {
        async readFile(path) {
          if (path === paths.compileMetadataPath) return revision.metadata;
          if (path === paths.compiledManifestPath) return malformedManifest;
          if (path === paths.diagnosticsPath) return revision.diagnostics;
          if (path === paths.discoveryManifestPath) return revision.discovery;
          if (path === paths.moduleMapPath) return revision.moduleMap;
          throw new Error(`Unexpected artifact read: ${path}`);
        },
      }),
    ).rejects.toThrow(
      'config source "memory::missing-agent.ts" does not match selected agent source "eve-memory-application:agent.ts"',
    );
  });
});

async function createDiskSources(name: string) {
  const compiled = await compileFromMemory({ model: "openai/gpt-5-mini", name });
  const appRoot = compiled.manifest.appRoot;
  const agentRoot = compiled.manifest.agentRoot;
  return {
    appRoot,
    compiled,
    diagnostics: serialize(compiled.diagnostics),
    discovery: serialize(createAgentSourceManifest({ agentId: name, agentRoot, appRoot })),
    manifest: serialize(compiled.manifest),
    metadata: serialize(compiled.metadata),
    moduleMap: serialize({
      identity: compiled.metadata.compile.moduleMap.identitySha256,
      nodes: Object.fromEntries(
        Object.entries(compiled.moduleMap.nodes).map(([nodeId, scope]) => [
          nodeId,
          { moduleIds: Object.keys(scope.modules).sort() },
        ]),
      ),
    }),
  };
}

function serialize(value: unknown): string {
  return serializeArtifactJson(value);
}
