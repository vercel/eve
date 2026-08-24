import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createCompileMetadata,
  resolveCompilerArtifactPaths,
  type CompileMetadata,
} from "#compiler/artifacts.js";
import { createProgrammaticCompiledModuleMapIdentity } from "#compiler/module-map.js";
import { collectCompiledModuleScopes } from "#compiler/module-scope.js";
import type { CompiledAgentManifest } from "#compiler/manifest.js";
import { createAgentSourceManifest } from "#discover/manifest.js";
import {
  createStubCompiledAgentManifest,
  TEST_COMPILED_AGENT_CONFIG_BINDING,
  TEST_COMPILED_AGENT_CONFIG_SOURCE,
} from "#internal/testing/compiled-manifest.js";
import { serializeArtifactJson } from "#protocol/artifact-json.js";
import { createCompilerDiagnosticsArtifact } from "#protocol/compiler-diagnostics-artifact.js";
import { createDiskRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { resolveRuntimeCompilerArtifactPaths } from "#runtime/loaders/artifact-paths.js";
import { LoadCompiledManifestError, loadCompiledManifest } from "#runtime/loaders/manifest.js";

function createChannelManifest(appRoot = "/app"): CompiledAgentManifest {
  const cors = { origin: ["https://example.com"] } as const;
  const get = {
    cors,
    kind: "channel" as const,
    logicalPath: "channels/get.ts",
    method: "GET" as const,
    name: "get",
    sourceId: "channel-get",
    sourceKind: "module" as const,
    urlPath: "/hooks/:id",
  };
  const post = {
    ...get,
    logicalPath: "channels/post.ts",
    method: "POST" as const,
    name: "post",
    sourceId: "channel-post",
    urlPath: "/hooks/:name",
  };
  return createStubCompiledAgentManifest({
    agentRoot: join(appRoot, "agent"),
    appRoot,
    bindings: [
      TEST_COMPILED_AGENT_CONFIG_BINDING,
      { logicalPath: get.logicalPath, sourceId: get.sourceId },
      { logicalPath: post.logicalPath, sourceId: post.sourceId },
    ],
    channelRoutes: {
      effective: [get, post],
      preflight: [{ cors, pathPattern: get.urlPath, sourceIds: [get.sourceId, post.sourceId] }],
      shadowed: [],
    },
    config: {
      model: { id: "openai/gpt-5-mini", routing: { kind: "gateway", target: "openai" } },
      name: "loader-test",
      source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
    },
  });
}

interface DiskManifestFixture {
  readonly diagnosticsSource: string;
  readonly discoveryManifestSource: string;
  readonly hydrationMarker: string;
  readonly manifest: CompiledAgentManifest;
  readonly manifestSource: string;
  readonly metadata: CompileMetadata;
  readonly moduleMapIdentity: string;
  readonly moduleMapSource: string;
}

function createModuleMapSource(input: {
  readonly hydrationMarker: string;
  readonly identity: string;
  readonly manifest: CompiledAgentManifest;
}): string {
  const nodes = collectCompiledModuleScopes(input.manifest)
    .map((scope) => {
      const modules = [...new Set(scope.refs.map((ref) => ref.sourceId))]
        .map((sourceId) => {
          const backing = scope.bindings[sourceId]!.backing;
          const validate = backing.kind === "programmatic" ? ", validate: () => undefined" : "";
          return `${JSON.stringify(sourceId)}: { artifactIdentity: ${JSON.stringify(input.identity)}, backing: ${JSON.stringify(backing)}, load: async () => ({})${validate} }`;
        })
        .join(", ");
      return `${JSON.stringify(scope.nodeId)}: { modules: { ${modules} } }`;
    })
    .join(", ");

  return [
    `globalThis[${JSON.stringify(input.hydrationMarker)}] = true;`,
    `export const moduleMapDescriptor = { identity: ${JSON.stringify(input.identity)}, nodes: { ${nodes} } };`,
    "export default moduleMapDescriptor;",
    "",
  ].join("\n");
}

async function createDiskManifestFixture(
  manifest: CompiledAgentManifest,
): Promise<DiskManifestFixture> {
  const diagnostics = createCompilerDiagnosticsArtifact([]);
  const diagnosticsSource = serializeArtifactJson(diagnostics);
  const discoveryManifestSource = serializeArtifactJson(
    createAgentSourceManifest({
      agentId: manifest.config.name,
      agentRoot: manifest.agentRoot,
      appRoot: manifest.appRoot,
    }),
  );
  const hydrationMarker = `__eve_manifest_hydration_${randomUUID()}`;
  const identity = createProgrammaticCompiledModuleMapIdentity(manifest);
  const moduleMapSource = createModuleMapSource({ hydrationMarker, identity, manifest });
  const manifestSource = serializeArtifactJson(manifest);
  const metadata = createCompileMetadata({
    appRoot: manifest.appRoot,
    compiledManifestJson: manifestSource,
    diagnosticsArtifactJson: diagnosticsSource,
    diagnosticsSummary: diagnostics.summary,
    discoveryManifestJson: discoveryManifestSource,
    moduleMapIdentity: identity,
    moduleMapSource,
    paths: resolveCompilerArtifactPaths(manifest.appRoot),
  });

  return {
    diagnosticsSource,
    discoveryManifestSource,
    hydrationMarker,
    manifest,
    manifestSource,
    metadata,
    moduleMapIdentity: identity,
    moduleMapSource,
  };
}

function replaceDiskManifest(
  fixture: DiskManifestFixture,
  manifest: CompiledAgentManifest,
): DiskManifestFixture {
  const manifestSource = serializeArtifactJson(manifest);
  const metadata = createCompileMetadata({
    appRoot: manifest.appRoot,
    compiledManifestJson: manifestSource,
    diagnosticsArtifactJson: fixture.diagnosticsSource,
    diagnosticsSummary: fixture.metadata.discovery.summary,
    discoveryManifestJson: fixture.discoveryManifestSource,
    moduleMapIdentity: fixture.moduleMapIdentity,
    moduleMapSource: fixture.moduleMapSource,
    paths: resolveCompilerArtifactPaths(manifest.appRoot),
  });
  return { ...fixture, manifest, manifestSource, metadata };
}

async function writeDiskManifestFixture(
  appRoot: string,
  fixture: DiskManifestFixture,
): Promise<void> {
  const paths = resolveRuntimeCompilerArtifactPaths(appRoot);
  await Promise.all([
    mkdir(dirname(paths.compileMetadataPath), { recursive: true }),
    mkdir(dirname(paths.diagnosticsPath), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(paths.compiledManifestPath, fixture.manifestSource, "utf8"),
    writeFile(paths.compileMetadataPath, serializeArtifactJson(fixture.metadata), "utf8"),
    writeFile(paths.diagnosticsPath, fixture.diagnosticsSource, "utf8"),
    writeFile(paths.discoveryManifestPath, fixture.discoveryManifestSource, "utf8"),
    writeFile(paths.moduleMapPath, fixture.moduleMapSource, "utf8"),
  ]);
}

async function publishDiskManifestMutation(
  appRoot: string,
  fixture: DiskManifestFixture,
): Promise<void> {
  const paths = resolveRuntimeCompilerArtifactPaths(appRoot);
  await writeFile(paths.compiledManifestPath, fixture.manifestSource, "utf8");
  await writeFile(paths.compileMetadataPath, serializeArtifactJson(fixture.metadata), "utf8");
}

async function expectDiskManifestToFail(input: {
  readonly expected: string;
  readonly mutate: (manifest: CompiledAgentManifest) => CompiledAgentManifest;
}): Promise<void> {
  const appRoot = await mkdtemp(join(tmpdir(), "eve-route-manifest-"));
  try {
    const valid = await createDiskManifestFixture(createChannelManifest(appRoot));
    await writeDiskManifestFixture(appRoot, valid);
    const invalid = replaceDiskManifest(valid, input.mutate(valid.manifest));
    await publishDiskManifestMutation(appRoot, invalid);

    const error = await loadCompiledManifest({
      compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(appRoot),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LoadCompiledManifestError);
    expect((error as Error).message).toContain(input.expected);
    expect((globalThis as Record<string, unknown>)[valid.hydrationMarker]).toBeUndefined();
  } finally {
    await rm(appRoot, { force: true, recursive: true });
  }
}

describe("disk compiled manifest route validation", () => {
  it("loads one unchanged coherent disk artifact set without hydrating its module map", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "eve-route-manifest-"));
    try {
      const fixture = await createDiskManifestFixture(createChannelManifest(appRoot));
      await writeDiskManifestFixture(appRoot, fixture);

      await expect(
        loadCompiledManifest({
          compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(appRoot),
        }),
      ).resolves.toEqual(fixture.manifest);
      expect((globalThis as Record<string, unknown>)[fixture.hydrationMarker]).toBeUndefined();
    } finally {
      await rm(appRoot, { force: true, recursive: true });
    }
  });

  it("rejects structurally valid disk artifacts with missing bindings", async () => {
    await expectDiskManifestToFail({
      expected: 'Compiled node "__root__" is missing a binding for "test:stub-agent-config".',
      mutate: (manifest) => ({
        ...manifest,
        bindings: Object.fromEntries(
          Object.entries(manifest.bindings).filter(
            ([sourceId]) => sourceId !== "test:stub-agent-config",
          ),
        ),
      }),
    });
  });

  it("rejects structurally valid disk artifacts with extra bindings", async () => {
    await expectDiskManifestToFail({
      expected: 'Compiled node "__root__" has an unreferenced binding for "extra".',
      mutate: (manifest) => ({
        ...manifest,
        bindings: {
          ...manifest.bindings,
          extra: {
            backing: {
              kind: "programmatic",
              moduleId: "extra",
              registryId: "test",
              revision: "test-revision",
            },
            logicalPath: "tools/extra.ts",
            owner: { kind: "application" },
          },
        },
      }),
    });
  });

  it("rejects structurally valid disk artifacts with path-mismatched bindings", async () => {
    await expectDiskManifestToFail({
      expected:
        'Compiled node "__root__" selects "test:stub-agent-config" for slot "agent", but its logical path identifies slot "tools/other".',
      mutate: (manifest) => ({
        ...manifest,
        bindings: {
          ...manifest.bindings,
          "test:stub-agent-config": {
            ...manifest.bindings["test:stub-agent-config"]!,
            logicalPath: "tools/other.ts",
          },
        },
      }),
    });
  });

  it("rejects unsupported channel route grammar", async () => {
    await expectDiskManifestToFail({
      expected: "[compile/channel-route-invalid-pattern]",
      mutate: (manifest) => ({
        ...manifest,
        channelRoutes: {
          ...manifest.channelRoutes,
          effective: [{ ...manifest.channelRoutes.effective[0]!, urlPath: "/hooks/:id?" }],
        },
      }),
    });
  });

  it("rejects incomplete preflight cause sets", async () => {
    await expectDiskManifestToFail({
      expected: 'ChannelRoutes.preflight at "/hooks/:id" has dangling causes.',
      mutate: (manifest) => ({
        ...manifest,
        channelRoutes: {
          ...manifest.channelRoutes,
          preflight: [
            {
              ...manifest.channelRoutes.preflight[0]!,
              sourceIds: [manifest.channelRoutes.preflight[0]!.sourceIds[0]!],
            },
          ],
        },
      }),
    });
  });

  it("rejects invalid normalized CORS values", async () => {
    await expectDiskManifestToFail({
      expected: "has invalid normalized CORS",
      mutate: (manifest) => ({
        ...manifest,
        channelRoutes: {
          ...manifest.channelRoutes,
          effective: [
            { ...manifest.channelRoutes.effective[0]!, cors: { maxAge: "" } },
            ...manifest.channelRoutes.effective.slice(1),
          ],
        },
      }),
    });
  });
});
