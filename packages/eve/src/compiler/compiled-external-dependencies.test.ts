import { describe, expect, it } from "vitest";

import { createFrameworkAgentSourceRegistry } from "#compiler/agent-source-registry.js";
import { withSelectedConfigExternalDependencies } from "#compiler/compiled-external-dependencies.js";
import {
  composeAgentConfigSources,
  type EffectiveAgentNodeSourceGraph,
} from "#compiler/effective-agent-source-graph.js";
import { defineProgrammaticAgentSource } from "#compiler/programmatic-agent-source.js";
import { createAgentSourceManifest, createModuleSourceRef } from "#discover/manifest.js";

const FILESYSTEM_CONFIG_SOURCE_ID = "application-agent-config";

function createFilesystemConfigGraph(): EffectiveAgentNodeSourceGraph {
  return composeAgentConfigSources({
    externalDependencies: [],
    isRoot: true,
    manifest: createAgentSourceManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      configModule: createModuleSourceRef({
        logicalPath: "agent.ts",
        sourceId: FILESYSTEM_CONFIG_SOURCE_ID,
      }),
    }),
    nodeId: "__root__",
  });
}

function assertSelectedConfigSourceIdIsRequired(graph: EffectiveAgentNodeSourceGraph): void {
  // @ts-expect-error External dependency finalization requires the selected config source ID.
  void withSelectedConfigExternalDependencies(graph, undefined, []);
}

describe("selected config external dependencies", () => {
  it("requires the selected source id and rejects its missing binding precisely", () => {
    const graph = createFilesystemConfigGraph();
    const invalid = { ...graph, bindings: {} };

    expect(assertSelectedConfigSourceIdIsRequired).toBeTypeOf("function");
    expect(() =>
      withSelectedConfigExternalDependencies(invalid, FILESYSTEM_CONFIG_SOURCE_ID, []),
    ).toThrowError(
      `Selected config source "${FILESYSTEM_CONFIG_SOURCE_ID}" is missing its binding.`,
    );
  });

  it("stamps the selected filesystem config binding and candidate descriptor", () => {
    const graph = createFilesystemConfigGraph();
    const updated = withSelectedConfigExternalDependencies(graph, FILESYSTEM_CONFIG_SOURCE_ID, [
      "sharp",
      "canvas",
    ]);

    expect(updated.bindings[FILESYSTEM_CONFIG_SOURCE_ID]?.backing).toMatchObject({
      externalDependencies: ["sharp", "canvas"],
      kind: "filesystem",
    });
    expect(updated.winners[0]?.descriptor).toMatchObject({
      backing: { externalDependencies: ["sharp", "canvas"], kind: "filesystem" },
      sourceId: FILESYSTEM_CONFIG_SOURCE_ID,
    });
    expect(graph.bindings[FILESYSTEM_CONFIG_SOURCE_ID]?.backing).toMatchObject({
      externalDependencies: [],
      kind: "filesystem",
    });
  });

  it("leaves a selected programmatic config graph unchanged", () => {
    const source = defineProgrammaticAgentSource({
      id: "framework-default",
      modules: [{ loadNamespace: () => ({ default: {} }), logicalPath: "agent.ts" }],
      revision: "test-revision",
    });
    const graph = composeAgentConfigSources({
      externalDependencies: [],
      isRoot: true,
      manifest: createAgentSourceManifest({ agentRoot: "/app/agent", appRoot: "/app" }),
      nodeId: "__root__",
      registry: createFrameworkAgentSourceRegistry({
        frameworkDefaultConfigSource: source,
        registrations: [{ applyTo: "all-local-nodes", source }],
      }),
    });
    const sourceId = graph.winners[0]!.descriptor.sourceId;

    expect(withSelectedConfigExternalDependencies(graph, sourceId, ["sharp"])).toBe(graph);
    expect(graph.bindings[sourceId]?.backing.kind).toBe("programmatic");
  });
});
