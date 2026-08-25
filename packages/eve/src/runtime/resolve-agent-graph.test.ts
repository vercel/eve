import { describe, expect, it } from "vitest";

import { compileFromMemory } from "#compiler/compile-from-memory.js";
import {
  createCompiledAgentNodeManifest,
  ROOT_COMPILED_AGENT_NODE_ID,
  type CompiledAgentDefinition,
} from "#compiler/manifest.js";
import { resolveRuntimeAgentGraph } from "#runtime/resolve-agent-graph.js";

describe("resolveRuntimeAgentGraph", () => {
  it("projects the root task capability onto every resolved node", async () => {
    const { manifest, moduleMap } = await compileFromMemory({
      agent: {
        experimental: { tasks: true },
        model: "openai/gpt-5.4",
      },
      model: "openai/gpt-5.4",
    });
    const childConfig: CompiledAgentDefinition = {
      ...manifest.config,
      experimental: undefined,
      name: "child",
    };
    const childAgent = createCompiledAgentNodeManifest({
      ...manifest,
      config: childConfig,
    });
    const childNodeId = "subagents/child";
    const graph = await resolveRuntimeAgentGraph({
      manifest: {
        ...manifest,
        subagents: [
          {
            agent: childAgent,
            backing: { kind: "resource", sourcePath: "/virtual/agent/subagents/child" },
            description: "Child agent.",
            entryPath: "/virtual/agent/subagents/child",
            logicalPath: "subagents/child",
            name: "child",
            nodeId: childNodeId,
            owner: { kind: "application" },
            parentNodeId: ROOT_COMPILED_AGENT_NODE_ID,
            rootPath: "/virtual/agent/subagents/child",
            sourceId: childNodeId,
            sourceKind: "module",
          },
        ],
      },
      moduleMap: {
        nodes: {
          ...moduleMap.nodes,
          [childNodeId]: moduleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID]!,
        },
      },
    });

    expect(graph.rootCapabilities).toEqual({ tasks: true });
    expect([...graph.nodesByNodeId.values()]).toHaveLength(2);
    for (const node of graph.nodesByNodeId.values()) {
      expect(node.rootCapabilities).toBe(graph.rootCapabilities);
    }
    const child = graph.nodesByNodeId.get(childNodeId);
    expect(child?.agent.config?.experimental?.tasks).toBeUndefined();
    expect(child?.rootCapabilities.tasks).toBe(true);
  });
});
