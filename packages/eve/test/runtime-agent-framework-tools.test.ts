import { describe, expect, it } from "vitest";

import {
  createCompiledAgentManifest,
  createCompiledAgentNodeManifest,
  ROOT_COMPILED_AGENT_NODE_ID,
} from "../src/compiler/manifest.js";
import { createNodeHarnessTools } from "../src/execution/node-step.js";
import { TEST_DEFAULT_MODEL_ID } from "../src/internal/testing/app-harness.js";
import { resolveRuntimeAgentGraph } from "../src/runtime/resolve-agent-graph.js";

describe("runtime agent framework tools", () => {
  it("lets an authored agent tool replace the built-in agent action", async () => {
    const manifest = createCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      config: {
        model: {
          id: TEST_DEFAULT_MODEL_ID,
          routing: { kind: "gateway", target: "openai" },
        },
        name: "weather-agent",
      },
      tools: [
        {
          description: "Delegate through an authored implementation.",
          inputSchema: null,
          logicalPath: "tools/agent.mjs",
          name: "agent",
          sourceId: "tools/agent.mjs",
          sourceKind: "module",
        },
      ],
    });
    const graph = await resolveRuntimeAgentGraph({
      manifest,
      moduleMap: {
        nodes: {
          [ROOT_COMPILED_AGENT_NODE_ID]: {
            modules: {
              "tools/agent.mjs": {
                default: {
                  description: "Delegate through an authored implementation.",
                  execute: () => "authored-agent",
                },
              },
            },
          },
        },
      },
    });

    expect(graph.root.turnAgent.tools.filter((tool) => tool.name === "agent")).toMatchObject([
      { kind: "authored-tool" },
    ]);
    expect(
      createNodeHarnessTools({ node: graph.root }).get("agent")?.runtimeAction,
    ).toBeUndefined();
  });

  it("lets a declared subagent named agent replace the built-in agent action", async () => {
    const child = createCompiledAgentNodeManifest({
      agentRoot: "/app/agent/subagents/agent",
      appRoot: "/app",
      config: {
        model: {
          id: TEST_DEFAULT_MODEL_ID,
          routing: { kind: "gateway", target: "openai" },
        },
        name: "agent",
      },
    });
    const manifest = createCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      config: {
        model: {
          id: TEST_DEFAULT_MODEL_ID,
          routing: { kind: "gateway", target: "openai" },
        },
        name: "root-agent",
      },
      subagentEdges: [
        {
          childNodeId: "subagents/agent",
          parentNodeId: ROOT_COMPILED_AGENT_NODE_ID,
        },
      ],
      subagents: [
        {
          agent: child,
          description: "A declared specialist named agent.",
          entryPath: "/app/agent/subagents/agent",
          logicalPath: "subagents/agent",
          name: "agent",
          nodeId: "subagents/agent",
          rootPath: "/app/agent/subagents/agent",
          sourceId: "subagents/agent",
          sourceKind: "module",
        },
      ],
    });
    const graph = await resolveRuntimeAgentGraph({
      manifest,
      moduleMap: {
        nodes: {
          [ROOT_COMPILED_AGENT_NODE_ID]: { modules: {} },
          "subagents/agent": { modules: {} },
        },
      },
    });

    expect(graph.root.turnAgent.tools.filter((tool) => tool.name === "agent")).toMatchObject([
      { kind: "subagent" },
    ]);
    const runtimeAction = createNodeHarnessTools({ node: graph.root }).get("agent")?.runtimeAction;
    expect(runtimeAction?.subagentName).toBe("agent");
  });
});
