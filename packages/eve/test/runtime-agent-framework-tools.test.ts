import { describe, expect, it } from "vitest";

import { ROOT_COMPILED_AGENT_NODE_ID } from "../src/compiler/manifest.js";
import { createNodeHarnessTools } from "../src/execution/node-step.js";
import { TEST_DEFAULT_MODEL_ID } from "../src/internal/testing/app-harness.js";
import {
  createStubCompiledAgentManifest as createCompiledAgentManifest,
  createStubCompiledAgentNodeManifest as createCompiledAgentNodeManifest,
  TEST_COMPILED_AGENT_CONFIG_BINDING,
  TEST_COMPILED_AGENT_CONFIG_SOURCE,
} from "../src/internal/testing/compiled-manifest.js";
import { resolveRuntimeAgentGraph } from "../src/runtime/resolve-agent-graph.js";

const TEST_SANDBOX_SOURCE_ID = "sandbox.ts";
const TEST_SANDBOX = {
  logicalPath: TEST_SANDBOX_SOURCE_ID,
  sourceHash: "test-sandbox",
  sourceId: TEST_SANDBOX_SOURCE_ID,
  sourceKind: "module" as const,
};
const TEST_SANDBOX_MODULE = { default: () => ({}) };

function createStubCompiledAgentManifest(input: Parameters<typeof createCompiledAgentManifest>[0]) {
  return createCompiledAgentManifest({ ...input, sandbox: input.sandbox ?? TEST_SANDBOX });
}

function createStubCompiledAgentNodeManifest(
  input: Parameters<typeof createCompiledAgentNodeManifest>[0],
  options: Parameters<typeof createCompiledAgentNodeManifest>[1],
) {
  return createCompiledAgentNodeManifest(
    { ...input, sandbox: input.sandbox ?? TEST_SANDBOX },
    options,
  );
}

async function resolveTestRuntimeAgentGraph(input: Parameters<typeof resolveRuntimeAgentGraph>[0]) {
  return resolveRuntimeAgentGraph({
    ...input,
    moduleMap: {
      nodes: Object.fromEntries(
        Object.entries(input.moduleMap.nodes).map(([nodeId, node]) => [
          nodeId,
          {
            modules: {
              [TEST_SANDBOX_SOURCE_ID]: TEST_SANDBOX_MODULE,
              ...node.modules,
            },
          },
        ]),
      ),
    },
  });
}

describe("runtime agent framework tools", () => {
  it("lets an authored agent tool replace the built-in agent action", async () => {
    const manifest = createStubCompiledAgentManifest({
      kernelPlan: { prepared: [] },
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [
        TEST_COMPILED_AGENT_CONFIG_BINDING,
        { logicalPath: "tools/agent.mjs", sourceId: "tools/agent.mjs" },
      ],
      config: {
        model: {
          id: TEST_DEFAULT_MODEL_ID,
          routing: { kind: "gateway", target: "openai" },
        },
        name: "weather-agent",
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
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
    const graph = await resolveTestRuntimeAgentGraph({
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
      createNodeHarnessTools({ kernelPlan: graph.root.agent.kernelPlan, node: graph.root }).get(
        "agent",
      )?.runtimeAction,
    ).toBeUndefined();
  });

  it("lets a declared subagent named agent replace the built-in agent action", async () => {
    const child = createStubCompiledAgentNodeManifest(
      {
        kernelPlan: { prepared: [] },
        agentRoot: "/app/agent/subagents/agent",
        appRoot: "/app",
        bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
        config: {
          model: {
            id: TEST_DEFAULT_MODEL_ID,
            routing: { kind: "gateway", target: "openai" },
          },
          name: "agent",
          source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
        },
      },
      { isRoot: false, nodeId: "subagents/agent" },
    );
    const manifest = createStubCompiledAgentManifest({
      kernelPlan: { prepared: [] },
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: [TEST_COMPILED_AGENT_CONFIG_BINDING],
      config: {
        model: {
          id: TEST_DEFAULT_MODEL_ID,
          routing: { kind: "gateway", target: "openai" },
        },
        name: "root-agent",
        source: TEST_COMPILED_AGENT_CONFIG_SOURCE,
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
          backing: {
            externalDependencies: [],
            kind: "filesystem",
            sourcePath: "/app/agent/subagents/agent",
          },
          description: "A declared specialist named agent.",
          entryPath: "/app/agent/subagents/agent",
          logicalPath: "subagents/agent",
          name: "agent",
          nodeId: "subagents/agent",
          owner: { kind: "application" },
          rootPath: "/app/agent/subagents/agent",
          sourceId: "subagents/agent",
          sourceKind: "subagent",
        },
      ],
    });
    const graph = await resolveTestRuntimeAgentGraph({
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
    const runtimeAction = createNodeHarnessTools({
      kernelPlan: graph.root.agent.kernelPlan,
      node: graph.root,
    }).get("agent")?.runtimeAction;
    expect(runtimeAction).toMatchObject({ kind: "subagent-call", subagentName: "agent" });
  });
});
