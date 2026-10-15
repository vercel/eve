import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeTurnAgent } from "#runtime/agent/bootstrap.js";
import { ROOT_RUNTIME_AGENT_NODE_ID, type ResolvedRuntimeAgentNode } from "#runtime/graph.js";
import { createRuntimeHookRegistry } from "#runtime/hooks/registry.js";
import type { RuntimeToolRegistry } from "#runtime/tools/registry.js";
import { createRuntimeToolRegistry } from "#runtime/tools/registry.js";
import { createPreparedRuntimeSubagentTool } from "#runtime/subagents/registry.js";
import { createNodeHarnessTools } from "#execution/node-step.js";
import { createStubSandboxRegistry } from "#internal/testing/stub-sandbox-registry.js";
import {
  AGENT_TOOL_DESCRIPTION,
  AGENT_TOOL_NAME,
  SUBAGENT_TOOL_INPUT_SCHEMA,
} from "#tools/framework/agent-contract.js";

// The harness runs outside a workflow body here, where run attributes cannot
// be written; the attribute contract is covered by emit.test.ts.
vi.mock("#runtime/attributes/emit.js", () => ({ setEveAttributes: vi.fn(async () => {}) }));

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  ToolLoopAgent: vi.fn(),
  isStepCount: vi.fn((count: number) => count),
  tool: vi.fn((definition: unknown) => definition),
}));

vi.mock("../runtime/agent/resolve-model.js", () => ({
  resolveRuntimeModelReference: vi.fn().mockResolvedValue({}),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

function createEmptyToolRegistry(): RuntimeToolRegistry {
  return {
    preparedTools: [],
    toolsByName: new Map(),
  };
}

type StaticRuntimeTurnAgent = Extract<RuntimeTurnAgent, { readonly model: unknown }>;

function createTestTurnAgent(overrides?: Partial<StaticRuntimeTurnAgent>): RuntimeTurnAgent {
  return {
    id: "test-agent",
    instructions: ["You are a test agent."],
    model: { id: "test-model" },
    tools: [],
    workspaceSpec: { rootEntries: [] },
    ...overrides,
  };
}

function createTestNode(
  turnAgent?: RuntimeTurnAgent,
  overrides: Partial<ResolvedRuntimeAgentNode> = {},
): ResolvedRuntimeAgentNode {
  const agent = {} as ResolvedRuntimeAgentNode["agent"];

  return {
    agent,
    channels: [],
    hookRegistry: createRuntimeHookRegistry([]),
    nodeId: ROOT_RUNTIME_AGENT_NODE_ID,
    sandboxRegistry: createStubSandboxRegistry(),
    subagentRegistry: {
      dynamicNodeIds: new Set(),
      dynamicResolvers: [],
      preparedTools: [],
      subagentsByName: new Map(),
      subagentsByNodeId: new Map(),
    },
    toolRegistry: createEmptyToolRegistry(),
    turnAgent: turnAgent ?? createTestTurnAgent(),
    ...overrides,
  };
}

async function createNodeWithSourceOwnedTools(input: {
  readonly names: readonly string[];
  readonly owner?:
    | { readonly kind: "application" }
    | { readonly feature: string; readonly kind: "framework" };
  readonly turnTools?: StaticRuntimeTurnAgent["tools"];
}): Promise<ResolvedRuntimeAgentNode> {
  const toolRegistry = await createRuntimeToolRegistry(
    {
      tools: input.names.map((name) => {
        const frameworkAgent = name === AGENT_TOOL_NAME && input.owner?.kind !== "application";
        return {
          behavior: frameworkAgent
            ? {
                availability: ["root-session"] as const,
                handling: { action: "self-agent" as const, kind: "dispatch" as const },
              }
            : undefined,
          description: frameworkAgent ? AGENT_TOOL_DESCRIPTION : `${name} programmatic tool.`,
          execute: async () => `${name}-sentinel`,
          inputSchema: frameworkAgent ? SUBAGENT_TOOL_INPUT_SCHEMA : null,
          logicalPath: `tools/${name}.ts`,
          name,
          owner: input.owner ?? { feature: "test", kind: "framework" },
          sourceId: `framework:tools/${name}.ts`,
          sourceKind: "module",
        };
      }),
    },
    { nodeId: ROOT_RUNTIME_AGENT_NODE_ID },
  );
  const node = createTestNode(
    createTestTurnAgent({
      tools: [...toolRegistry.preparedTools, ...(input.turnTools ?? [])],
    }),
    { toolRegistry },
  );
  return {
    ...node,
    agent: {
      ...node.agent,
      config: {
        model: { id: "test-model" },
        name: "test",
      },
    },
  };
}

describe("createNodeHarnessTools", () => {
  it("adds the framework label start callback to provider-managed web search", async () => {
    const node = await createNodeWithSourceOwnedTools({ names: ["web_search"] });
    const label = createNodeHarnessTools({ node }).get("web_search")?.label?.start;

    expect(label?.({ query: "Slack plan blocks" })).toBe("Search Slack plan blocks");
  });

  it("does not add the framework label to an authored web_search override", async () => {
    const node = await createNodeWithSourceOwnedTools({
      names: ["web_search"],
      owner: { kind: "application" },
    });

    expect(createNodeHarnessTools({ node }).get("web_search")?.label?.start).toBeUndefined();
  });

  it("lowers the compiled framework agent tool as a workflow tool", async () => {
    const node = await createNodeWithSourceOwnedTools({ names: ["agent"] });
    const agentTool = createNodeHarnessTools({ node }).get("agent");

    expect(agentTool?.description).toContain("split a large task into independent pieces");
    expect(agentTool?.description).toContain("several agents can work at once");
    expect(agentTool?.description).toContain("state the goal, what to return");
    expect(agentTool?.description).toContain("put everything it needs in message");
    expect(agentTool?.description).toContain("non-overlapping scopes");
    expect(agentTool?.description).not.toMatch(/\beve\b/);
    expect(agentTool?.execute).toBeUndefined();
    expect(agentTool?.workflowId).toBe("workflow//eve//agentToolServeWorkflow");
  });

  it("keeps an authored agent tool separate from self-delegation", async () => {
    const node = await createNodeWithSourceOwnedTools({
      names: ["agent"],
      owner: { kind: "application" },
    });
    const agentTool = createNodeHarnessTools({ node }).get("agent");

    expect(agentTool?.availableInSubagents).toBeUndefined();
    expect(agentTool).not.toHaveProperty("resultKind");
    expect(agentTool?.rootOnly).toBeUndefined();
    expect(agentTool?.workflowId).toBeUndefined();
  });

  it("lowers compiled local and remote delegation tools as workflow tools", async () => {
    const delegationTools: StaticRuntimeTurnAgent["tools"] = [
      createPreparedRuntimeSubagentTool({
        description: "Delegate local research.",
        kind: "subagent",
        logicalPath: "subagents/research",
        name: "research",
        nodeId: "subagents/research",
        sourceId: "subagents/research",
        sourceKind: "module",
      }),
      createPreparedRuntimeSubagentTool({
        description: "Delegate remote review.",
        kind: "remote",
        logicalPath: "remote-agents/reviewer",
        name: "reviewer",
        nodeId: "remote-agents/reviewer",
        path: "/eve/v1/session",
        sourceId: "remote-agents/reviewer",
        sourceKind: "module",
        url: "https://review.example.com",
      }),
    ];
    const tools = createNodeHarnessTools({
      node: await createNodeWithSourceOwnedTools({
        names: ["agent"],
        turnTools: delegationTools,
      }),
    });
    for (const name of ["research", "reviewer"]) {
      expect(tools.get(name)?.execute).toBeUndefined();
      expect(tools.get(name)?.workflowId).toBe("workflow//eve//agentToolServeWorkflow");
    }
  });
});
