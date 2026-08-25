import { describe, expect, it } from "vitest";

import {
  createCompiledAgentManifest,
  createCompiledAgentNodeManifest,
  ROOT_COMPILED_AGENT_NODE_ID,
  type CompiledToolDefinition,
  type CreateCompiledAgentResourcesInput,
} from "../src/compiler/manifest.js";
import type { CompiledModuleBinding } from "../src/compiler/source-graph.js";
import { createNodeHarnessTools } from "../src/execution/node-step.js";
import { TEST_DEFAULT_MODEL_ID } from "../src/internal/testing/app-harness.js";
import {
  EMPTY_CHANNEL_ROUTE_PLAN,
  EMPTY_SOURCE_COMPOSITION,
  testCompiledSandbox,
  testSandboxModuleNamespace,
} from "../src/internal/testing/compiled-node-fixtures.js";
import * as frameworkAgentToolModule from "../src/public/tools/agent.js";
import { resolveRuntimeAgentGraph } from "../src/runtime/resolve-agent-graph.js";

const TEST_SANDBOX = testCompiledSandbox();

const FRAMEWORK_AGENT_TOOL_SOURCE_ID = "eve-root:tools/agent.ts";

const FRAMEWORK_AGENT_TOOL_ROW: CompiledToolDefinition = {
  description: frameworkAgentToolModule.AGENT_TOOL_DESCRIPTION,
  inputSchema: null,
  logicalPath: "tools/agent.ts",
  name: "agent",
  sourceId: FRAMEWORK_AGENT_TOOL_SOURCE_ID,
  sourceKind: "module",
};

const FRAMEWORK_AGENT_TOOL_BINDING: CompiledModuleBinding = {
  backing: {
    kind: "programmatic",
    moduleId: "tools/agent.ts",
    registryId: "eve",
    revision: "test",
  },
  logicalPath: "tools/agent.ts",
  owner: { feature: "tools/agent", kind: "framework" },
};

function baseNodeInput(): Pick<
  CreateCompiledAgentResourcesInput,
  "bindings" | "sandbox" | "sourceComposition"
> {
  return {
    bindings: {},
    sandbox: TEST_SANDBOX,
    sourceComposition: EMPTY_SOURCE_COMPOSITION,
  };
}

function sandboxModules(): Record<string, Record<string, unknown>> {
  return { [TEST_SANDBOX.sourceId]: testSandboxModuleNamespace() };
}

describe("runtime agent framework tools", () => {
  it("turns a framework-owned compiled agent row into the harness delegation tool", async () => {
    const manifest = createCompiledAgentManifest({
      ...baseNodeInput(),
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: {
        [FRAMEWORK_AGENT_TOOL_SOURCE_ID]: FRAMEWORK_AGENT_TOOL_BINDING,
      },
      channelRoutes: EMPTY_CHANNEL_ROUTE_PLAN,
      config: {
        model: {
          id: TEST_DEFAULT_MODEL_ID,
          routing: { kind: "gateway", target: "openai" },
        },
        name: "weather-agent",
      },
      tools: [FRAMEWORK_AGENT_TOOL_ROW],
    });
    const graph = await resolveRuntimeAgentGraph({
      manifest,
      moduleMap: {
        nodes: {
          [ROOT_COMPILED_AGENT_NODE_ID]: {
            modules: {
              ...sandboxModules(),
              [FRAMEWORK_AGENT_TOOL_SOURCE_ID]: frameworkAgentToolModule,
            },
          },
        },
      },
    });

    expect(graph.root.turnAgent.tools.filter((tool) => tool.name === "agent")).toMatchObject([
      { kind: "authored-tool", owner: { kind: "framework" } },
    ]);
    const runtimeAction = createNodeHarnessTools({ node: graph.root }).get("agent")?.runtimeAction;
    expect(runtimeAction).toMatchObject({ kind: "subagent-call", subagentName: "agent" });
  });

  it("runs an application-owned agent row as an ordinary tool", async () => {
    const manifest = createCompiledAgentManifest({
      ...baseNodeInput(),
      agentRoot: "/app/agent",
      appRoot: "/app",
      bindings: {
        "tools/agent.mjs": {
          backing: {
            externalDependencies: [],
            kind: "filesystem",
            sourcePath: "/app/agent/tools/agent.mjs",
          },
          logicalPath: "tools/agent.mjs",
          owner: { kind: "application" },
        },
      },
      channelRoutes: EMPTY_CHANNEL_ROUTE_PLAN,
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
              ...sandboxModules(),
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
      { kind: "authored-tool", owner: { kind: "application" } },
    ]);
    expect(
      createNodeHarnessTools({ node: graph.root }).get("agent")?.runtimeAction,
    ).toBeUndefined();
  });

  it("does not inject the delegation tool when the compiled manifest carries no framework agent row", async () => {
    const manifest = createCompiledAgentManifest({
      ...baseNodeInput(),
      agentRoot: "/app/agent",
      appRoot: "/app",
      channelRoutes: EMPTY_CHANNEL_ROUTE_PLAN,
      config: {
        model: {
          id: TEST_DEFAULT_MODEL_ID,
          routing: { kind: "gateway", target: "openai" },
        },
        name: "weather-agent",
      },
    });
    const graph = await resolveRuntimeAgentGraph({
      manifest,
      moduleMap: {
        nodes: {
          [ROOT_COMPILED_AGENT_NODE_ID]: { modules: sandboxModules() },
        },
      },
    });

    expect(createNodeHarnessTools({ node: graph.root }).has("agent")).toBe(false);
  });

  it("lets a declared subagent named agent take the agent tool slot", async () => {
    const child = createCompiledAgentNodeManifest({
      ...baseNodeInput(),
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
      ...baseNodeInput(),
      agentRoot: "/app/agent",
      appRoot: "/app",
      channelRoutes: EMPTY_CHANNEL_ROUTE_PLAN,
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
          [ROOT_COMPILED_AGENT_NODE_ID]: { modules: sandboxModules() },
          "subagents/agent": { modules: sandboxModules() },
        },
      },
    });

    expect(graph.root.turnAgent.tools.filter((tool) => tool.name === "agent")).toMatchObject([
      { kind: "subagent" },
    ]);
    const runtimeAction = createNodeHarnessTools({ node: graph.root }).get("agent")?.runtimeAction;
    expect(runtimeAction).toMatchObject({ kind: "subagent-call", subagentName: "agent" });
  });
});
