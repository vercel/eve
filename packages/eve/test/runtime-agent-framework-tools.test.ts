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
  it("denies unlisted framework tools while preserving authored overrides", async () => {
    const manifest = createCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      config: {
        builtInTools: { mode: "allowlist", allow: ["todo"] },
        model: {
          id: TEST_DEFAULT_MODEL_ID,
          routing: { kind: "gateway", target: "openai" },
        },
        name: "restricted-agent",
      },
      tools: [
        {
          description: "Application-owned fetch implementation.",
          inputSchema: null,
          logicalPath: "tools/web-fetch.mjs",
          name: "web_fetch",
          sourceId: "tools/web-fetch.mjs",
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
              "tools/web-fetch.mjs": {
                default: {
                  description: "Application-owned fetch implementation.",
                  execute: () => "authored-fetch",
                },
              },
            },
          },
        },
      },
    });

    expect(graph.root.turnAgent.tools.map((tool) => tool.name)).toContain("todo");
    expect(graph.root.turnAgent.tools.map((tool) => tool.name)).toContain("web_fetch");
    expect(graph.root.turnAgent.tools.map((tool) => tool.name)).not.toContain("bash");
    expect(createNodeHarnessTools({ node: graph.root }).has("agent")).toBe(false);
  });

  it("keeps the built-in agent action when explicitly allowed", async () => {
    const manifest = createCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      config: {
        builtInTools: { mode: "allowlist", allow: ["agent"] },
        model: {
          id: TEST_DEFAULT_MODEL_ID,
          routing: { kind: "gateway", target: "openai" },
        },
        name: "delegating-agent",
      },
    });
    const graph = await resolveRuntimeAgentGraph({
      manifest,
      moduleMap: {
        nodes: {
          [ROOT_COMPILED_AGENT_NODE_ID]: { modules: {} },
        },
      },
    });

    expect(createNodeHarnessTools({ node: graph.root }).has("agent")).toBe(true);
    expect(graph.root.turnAgent.tools.map((tool) => tool.name)).not.toContain("bash");
  });

  it("rejects unknown names in the built-in tool allowlist", async () => {
    const manifest = createCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      config: {
        builtInTools: { mode: "allowlist", allow: ["todo_typo"] },
        model: {
          id: TEST_DEFAULT_MODEL_ID,
          routing: { kind: "gateway", target: "openai" },
        },
        name: "invalid-agent",
      },
    });

    await expect(
      resolveRuntimeAgentGraph({
        manifest,
        moduleMap: {
          nodes: {
            [ROOT_COMPILED_AGENT_NODE_ID]: { modules: {} },
          },
        },
      }),
    ).rejects.toThrow(
      'defineAgent({ builtInTools }) allows "todo_typo", but it is not a framework tool.',
    );
  });

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
