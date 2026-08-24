import { describe, expect, it } from "vitest";

import { compileFromMemory } from "#compiler/compile-from-memory.js";
import {
  ROOT_COMPILED_AGENT_NODE_ID,
  type CompiledAgentManifest,
  type CompiledSubagentNode,
} from "#compiler/manifest.js";
import {
  createTestCompiledAgentResources,
  TEST_COMPILED_SANDBOX_MODULE,
  TEST_COMPILED_SANDBOX_SOURCE_ID,
} from "#internal/testing/compiled-manifest.js";
import { validateCompiledArtifactSetSemantics } from "#protocol/compiled-artifact-set.js";
import { identifyCompiledModuleMap } from "#protocol/compiled-module-map-identity.js";

describe("compiled artifact set semantics", () => {
  it("accepts an exact manifest, diagnostics, metadata, and module-map snapshot", async () => {
    const compiled = await compileFromMemory({
      model: "openai/gpt-5-mini",
      tools: [{ name: "search" }],
    });

    expect(validateCompiledArtifactSetSemantics(compiled)).toEqual([]);
  });

  it("rejects ready metadata when diagnostics contain an error", async () => {
    const compiled = await compileFromMemory({ model: "openai/gpt-5-mini" });
    const diagnostics = {
      ...compiled.diagnostics,
      diagnostics: [
        {
          code: "compile/test",
          logicalPath: "agent.ts",
          message: "test error",
          nodeId: ROOT_COMPILED_AGENT_NODE_ID,
          severity: "error" as const,
        },
      ],
      summary: { errors: 1, warnings: 0 },
    };

    expect(
      validateCompiledArtifactSetSemantics({
        ...compiled,
        diagnostics,
        manifest: { ...compiled.manifest, diagnosticsSummary: diagnostics.summary },
        metadata: {
          ...compiled.metadata,
          discovery: { ...compiled.metadata.discovery, summary: diagnostics.summary },
        },
      }),
    ).toContainEqual(expect.stringContaining("requires zero compiler errors"));
  });

  it("requires exact node and module key equality", async () => {
    const compiled = await compileFromMemory({
      model: "openai/gpt-5-mini",
      tools: [{ name: "search" }],
    });
    const rootModules = compiled.moduleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID]!.modules;
    const searchSourceId = compiled.manifest.tools.find((tool) => tool.name === "search")!.sourceId;

    expect(
      validateCompiledArtifactSetSemantics({
        ...compiled,
        moduleMap: { nodes: {} },
      }),
    ).toContainEqual(expect.stringContaining('missing node "__root__"'));
    expect(
      validateCompiledArtifactSetSemantics({
        ...compiled,
        moduleMap: {
          nodes: { ...compiled.moduleMap.nodes, unexpected: { modules: {} } },
        },
      }),
    ).toContainEqual(expect.stringContaining('unexpected node "unexpected"'));
    expect(
      validateCompiledArtifactSetSemantics({
        ...compiled,
        moduleMap: {
          nodes: {
            [ROOT_COMPILED_AGENT_NODE_ID]: {
              modules: Object.fromEntries(
                Object.entries(rootModules).filter(([sourceId]) => sourceId !== searchSourceId),
              ),
            },
          },
        },
      }),
    ).toContainEqual(expect.stringContaining(`missing module "${searchSourceId}"`));
    expect(
      validateCompiledArtifactSetSemantics({
        ...compiled,
        moduleMap: {
          nodes: {
            [ROOT_COMPILED_AGENT_NODE_ID]: {
              modules: { ...rootModules, "memory::unexpected.ts": {} },
            },
          },
        },
      }),
    ).toContainEqual(expect.stringContaining('unexpected module "memory::unexpected.ts"'));
  });

  it("includes a dynamic subagent config resolver in the child module scope", async () => {
    const compiled = await compileFromMemory({ model: "openai/gpt-5-mini" });
    const resolver = {
      eventNames: ["session.started"],
      logicalPath: "agent.ts",
      sourceId: "child::agent.ts",
      sourceKind: "module" as const,
    };
    const childAgent = createTestCompiledAgentResources(
      {
        agentRoot: "/virtual/eve-memory-app/agent/subagents/child",
        appRoot: "/virtual/eve-memory-app",
        bindings: [{ logicalPath: resolver.logicalPath, sourceId: resolver.sourceId }],
      },
      { additionalBindingReferences: [resolver], isRoot: false, nodeId: "subagents/child" },
    );
    const child: CompiledSubagentNode = {
      agent: childAgent,
      backing: {
        kind: "programmatic",
        moduleId: "child-source",
        registryId: "test-compiled-artifact-set",
        revision: "test-revision",
      },
      configResolver: resolver,
      entryPath: "/virtual/eve-memory-app/agent/subagents/child/agent.ts",
      logicalPath: "subagents/child",
      name: "child",
      nodeId: "subagents/child",
      owner: { kind: "application" },
      rootPath: "/virtual/eve-memory-app/agent/subagents/child",
      sourceId: "child-source",
      sourceKind: "subagent",
    };
    const manifest: CompiledAgentManifest = {
      ...compiled.manifest,
      subagentEdges: [{ childNodeId: child.nodeId, parentNodeId: ROOT_COMPILED_AGENT_NODE_ID }],
      subagents: [child],
    };
    const moduleMap = identifyCompiledModuleMap(
      {
        nodes: {
          ...compiled.moduleMap.nodes,
          [child.nodeId]: {
            modules: {
              [resolver.sourceId]: {},
              [TEST_COMPILED_SANDBOX_SOURCE_ID]: TEST_COMPILED_SANDBOX_MODULE,
            },
          },
        },
      },
      compiled.metadata.compile.moduleMap.identitySha256,
    );

    expect(validateCompiledArtifactSetSemantics({ ...compiled, manifest, moduleMap })).toEqual([]);
    expect(
      validateCompiledArtifactSetSemantics({
        ...compiled,
        manifest,
        moduleMap: {
          nodes: {
            ...moduleMap.nodes,
            [child.nodeId]: {
              modules: { [TEST_COMPILED_SANDBOX_SOURCE_ID]: TEST_COMPILED_SANDBOX_MODULE },
            },
          },
        },
      }),
    ).toContainEqual(expect.stringContaining(`missing module "${resolver.sourceId}"`));
  });
});
