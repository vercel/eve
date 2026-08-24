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
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { createCompilerDiagnosticsArtifact } from "#protocol/compiler-diagnostics-artifact.js";
import type { CompilerDiagnosticsArtifact } from "#protocol/compiler-diagnostics-artifact.js";
import {
  type BundledCompiledModuleMapDescriptor,
  installBundledCompiledArtifactsFromDescriptor,
} from "#runtime/loaders/bundled-artifacts.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";
import { createRuntimeSession, withRuntimeSession } from "#runtime/sessions/runtime-session.js";

function createManifest(): CompiledAgentManifest {
  return createStubCompiledAgentManifest({
    agentRoot: "/app/agent",
    appRoot: "/app",
    bindings: [
      TEST_COMPILED_AGENT_CONFIG_BINDING,
      { logicalPath: "tools/search.ts", sourceId: "opaque-tool-source" },
    ],
    config: {
      model: { id: "openai/gpt-5-mini", routing: { kind: "gateway", target: "openai" } },
      name: "loader-test",
      source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
    },
    tools: [
      {
        description: "Search.",
        inputSchema: null,
        logicalPath: "tools/search.ts",
        name: "search",
        sourceId: "opaque-tool-source",
        sourceKind: "module",
      },
    ],
  });
}

function createChannelManifest(): CompiledAgentManifest {
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
    agentRoot: "/app/agent",
    appRoot: "/app",
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

function createWorkspaceManifest(): CompiledAgentManifest {
  return createStubCompiledAgentManifest({
    agentRoot: "/app/agent",
    appRoot: "/app",
    bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
    config: {
      model: { id: "openai/gpt-5-mini", routing: { kind: "gateway", target: "openai" } },
      name: "loader-test",
      source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
    },
    sandboxWorkspaces: [
      {
        logicalPath: "sandbox/workspace",
        rootEntries: ["seed.txt"],
        sourceId: "workspace-source",
        sourcePath: "/app/agent/sandbox/workspace",
      },
    ],
    workspaceResourceRoot: {
      contentHash: "a".repeat(64),
      logicalPath: "workspace-resources/__root__",
      rootEntries: ["seed.txt"],
    },
  });
}

interface BundledManifestFixture {
  readonly diagnostics: CompilerDiagnosticsArtifact;
  readonly discoveryManifestSource: string;
  readonly manifest: CompiledAgentManifest;
  readonly metadata: CompileMetadata;
  readonly moduleMapDescriptor: BundledCompiledModuleMapDescriptor;
  readonly moduleMapSource: string;
}

function createBundledMetadata(input: {
  readonly diagnostics: CompilerDiagnosticsArtifact;
  readonly discoveryManifestSource: string;
  readonly manifest: CompiledAgentManifest;
  readonly moduleMapIdentity: string;
  readonly moduleMapSource: string;
}): CompileMetadata {
  return createCompileMetadata({
    appRoot: input.manifest.appRoot,
    compiledManifestJson: serializeArtifactJson(input.manifest),
    diagnosticsArtifactJson: serializeArtifactJson(input.diagnostics),
    diagnosticsSummary: input.diagnostics.summary,
    discoveryManifestJson: input.discoveryManifestSource,
    moduleMapIdentity: input.moduleMapIdentity,
    moduleMapSource: input.moduleMapSource,
    paths: resolveCompilerArtifactPaths(input.manifest.appRoot),
  });
}

function replaceBundledManifest(
  fixture: BundledManifestFixture,
  manifest: CompiledAgentManifest,
): BundledManifestFixture {
  const metadata = createBundledMetadata({
    ...fixture,
    manifest,
    moduleMapIdentity: fixture.moduleMapDescriptor.identity,
  });
  return { ...fixture, manifest, metadata };
}

async function createBundledManifestFixture(input: {
  readonly manifest: CompiledAgentManifest;
  readonly onHydrate?: (sourceId: string) => void;
}): Promise<BundledManifestFixture> {
  const diagnostics = createCompilerDiagnosticsArtifact([]);
  const identity = createProgrammaticCompiledModuleMapIdentity(input.manifest);
  const nodes: Record<
    string,
    {
      modules: Record<
        string,
        BundledCompiledModuleMapDescriptor["nodes"][string]["modules"][string]
      >;
    }
  > = {};

  for (const scope of collectCompiledModuleScopes(input.manifest)) {
    const modules: (typeof nodes)[string]["modules"] = {};
    for (const sourceId of new Set(scope.refs.map((ref) => ref.sourceId))) {
      const backing = scope.bindings[sourceId]!.backing;
      modules[sourceId] =
        backing.kind === "programmatic"
          ? {
              artifactIdentity: identity,
              backing,
              load: async () => {
                input.onHydrate?.(sourceId);
                return {};
              },
              validate: () => undefined,
            }
          : {
              artifactIdentity: identity,
              backing,
              load: async () => {
                input.onHydrate?.(sourceId);
                return {};
              },
            };
    }
    nodes[scope.nodeId] = { modules };
  }

  const moduleMapDescriptor = { identity, nodes };
  const discoveryManifestSource = serializeArtifactJson(
    createAgentSourceManifest({
      agentId: input.manifest.config.name,
      agentRoot: input.manifest.agentRoot,
      appRoot: input.manifest.appRoot,
    }),
  );
  const moduleMapSource = serializeArtifactJson({
    identity,
    nodes: Object.fromEntries(
      Object.entries(nodes).map(([nodeId, scope]) => [
        nodeId,
        { sourceIds: Object.keys(scope.modules).sort() },
      ]),
    ),
  });
  const metadata = createBundledMetadata({
    diagnostics,
    discoveryManifestSource,
    manifest: input.manifest,
    moduleMapIdentity: identity,
    moduleMapSource,
  });
  return {
    diagnostics,
    discoveryManifestSource,
    manifest: input.manifest,
    metadata,
    moduleMapDescriptor,
    moduleMapSource,
  };
}

async function expectBundledManifestToFail(input: {
  readonly expected: string;
  readonly manifest: CompiledAgentManifest;
  readonly mutate: (manifest: CompiledAgentManifest) => CompiledAgentManifest;
}): Promise<void> {
  const hydratedSourceIds: string[] = [];
  const valid = await createBundledManifestFixture({
    manifest: input.manifest,
    onHydrate: (sourceId) => hydratedSourceIds.push(sourceId),
  });
  const invalid = replaceBundledManifest(valid, input.mutate(input.manifest));

  await withRuntimeSession(createRuntimeSession("invalid-manifest-loader-test"), async () => {
    await expect(installBundledCompiledArtifactsFromDescriptor(invalid)).rejects.toThrow(
      input.expected,
    );
  });
  expect(hydratedSourceIds).toEqual([]);
}

describe("loadCompiledManifest", () => {
  it("loads one unchanged coherent bundled artifact set", async () => {
    const manifest = createManifest();
    const hydratedSourceIds: string[] = [];
    const fixture = await createBundledManifestFixture({
      manifest,
      onHydrate: (sourceId) => hydratedSourceIds.push(sourceId),
    });

    await withRuntimeSession(createRuntimeSession("valid-manifest-loader-test"), async () => {
      await installBundledCompiledArtifactsFromDescriptor(fixture);
      await expect(
        loadCompiledManifest({
          compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
        }),
      ).resolves.toEqual(manifest);
    });
    expect(hydratedSourceIds.sort()).toEqual(
      collectCompiledModuleScopes(manifest)
        .flatMap((scope) => scope.refs.map((ref) => ref.sourceId))
        .filter((sourceId, index, sourceIds) => sourceIds.indexOf(sourceId) === index)
        .sort(),
    );
  });

  it("rejects structurally valid bundled artifacts with missing bindings", async () => {
    await expectBundledManifestToFail({
      expected: 'Compiled node "__root__" is missing a binding for "opaque-tool-source".',
      manifest: createManifest(),
      mutate: (manifest) => ({
        ...manifest,
        bindings: Object.fromEntries(
          Object.entries(manifest.bindings).filter(
            ([sourceId]) => sourceId !== "opaque-tool-source",
          ),
        ),
      }),
    });
  });

  it("rejects structurally valid bundled artifacts with extra bindings", async () => {
    await expectBundledManifestToFail({
      expected: 'Compiled node "__root__" has an unreferenced binding for "extra".',
      manifest: createManifest(),
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

  it("rejects structurally valid bundled artifacts with path-mismatched bindings", async () => {
    await expectBundledManifestToFail({
      expected:
        'Compiled node "__root__" selects "opaque-tool-source" for slot "tools/search", but its logical path identifies slot "tools/other".',
      manifest: createManifest(),
      mutate: (manifest) => ({
        ...manifest,
        bindings: {
          ...manifest.bindings,
          "opaque-tool-source": {
            ...manifest.bindings["opaque-tool-source"]!,
            logicalPath: "tools/other.ts",
          },
        },
      }),
    });
  });

  it("rejects bundled artifacts whose serialized kernel plan disagrees with resources", async () => {
    await expectBundledManifestToFail({
      expected: 'Compiled node "__root__" kernel plan must exactly equal',
      manifest: createManifest(),
      mutate: (manifest) => ({
        ...manifest,
        kernelPlan: {
          prepared: manifest.kernelPlan.prepared.filter((name) => name !== "ask_question"),
        },
      }),
    });
  });

  it("rejects structurally valid bundled extension bindings without scope", async () => {
    await expectBundledManifestToFail({
      expected:
        'Compiled node "__root__" has an extension-owned filesystem binding for "opaque-tool-source" without an extension scope.',
      manifest: createManifest(),
      mutate: (manifest) => ({
        ...manifest,
        bindings: {
          ...manifest.bindings,
          "opaque-tool-source": {
            backing: {
              externalDependencies: [],
              kind: "filesystem",
              sourcePath: "/packages/search-extension/tools/search.ts",
            },
            logicalPath: "tools/search.ts",
            owner: {
              kind: "extension",
              namespace: "search",
              packageName: "@acme/search-extension",
            },
          },
        },
      }),
    });
  });

  it("rejects bundled managed workspace resources without a content identity", async () => {
    await expectBundledManifestToFail({
      expected:
        'Compiled node "__root__" has managed workspace resources but no compiled contentHash.',
      manifest: createWorkspaceManifest(),
      mutate: (manifest) => ({
        ...manifest,
        workspaceResourceRoot: {
          logicalPath: manifest.workspaceResourceRoot.logicalPath,
          rootEntries: manifest.workspaceResourceRoot.rootEntries,
        },
      }),
    });
  });

  it("rejects bundled channel plans with unsupported route grammar", async () => {
    await expectBundledManifestToFail({
      expected: "[compile/channel-route-invalid-pattern]",
      manifest: createChannelManifest(),
      mutate: (manifest) => ({
        ...manifest,
        channelRoutes: {
          ...manifest.channelRoutes,
          effective: [{ ...manifest.channelRoutes.effective[0]!, urlPath: "/hooks/**" }],
        },
      }),
    });
  });

  it("rejects bundled channel plans with incomplete preflight cause sets", async () => {
    await expectBundledManifestToFail({
      expected: 'ChannelRoutes.preflight at "/hooks/:id" has dangling causes.',
      manifest: createChannelManifest(),
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

  it("rejects bundled channel plans with invalid normalized CORS values", async () => {
    await expectBundledManifestToFail({
      expected: "has invalid normalized CORS",
      manifest: createChannelManifest(),
      mutate: (manifest) => ({
        ...manifest,
        channelRoutes: {
          ...manifest.channelRoutes,
          effective: [
            { ...manifest.channelRoutes.effective[0]!, cors: { origin: [""] } },
            ...manifest.channelRoutes.effective.slice(1),
          ],
        },
      }),
    });
  });
});
