import { ToolLoopAgent } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "#channel/types.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey, InitiatorAuthKey, SessionIdKey, SessionKey } from "#context/keys.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { getPendingRuntimeActionBatch } from "#harness/runtime-actions.js";
import type { RuntimeTurnAgent } from "#runtime/agent/bootstrap.js";
import { resolveRuntimeModelReference } from "#runtime/agent/resolve-model.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { ROOT_RUNTIME_AGENT_NODE_ID, type ResolvedRuntimeAgentNode } from "#runtime/graph.js";
import { createEmptyHookRegistry } from "#runtime/hooks/registry.js";
import type { RuntimeToolRegistry } from "#runtime/tools/registry.js";
import { createRuntimeToolRegistry } from "#runtime/tools/registry.js";
import { createExecutionNodeStep, createNodeHarnessTools } from "#execution/node-step.js";
import { countLocalSubagentCalls } from "#execution/tools/subagent/local.js";
import { createSession } from "#execution/session.js";
import { createStubSandboxRegistry } from "#internal/testing/stub-sandbox-registry.js";
import { toInputSchema } from "#tools/schema.js";

vi.mock("ai", () => ({
  ToolLoopAgent: vi.fn(),
  jsonSchema: vi.fn((schema: unknown) => schema),
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

function setupMockAgentForToolExecution(toolName: string, args: unknown): void {
  vi.mocked(ToolLoopAgent).mockImplementation(function (
    this: Record<string, unknown>,
    settings: Record<string, unknown>,
  ) {
    const prepareStep = settings.prepareStep as
      | ((...args: unknown[]) => Promise<unknown>)
      | undefined;
    const onStepFinish = settings.onStepFinish as
      | ((...args: unknown[]) => Promise<unknown>)
      | undefined;

    this.generate = vi.fn().mockImplementation(async (options: { messages: unknown[] }) => {
      if (prepareStep) {
        await prepareStep({
          messages: options.messages,
          steps: [],
          stepNumber: 0,
          model: {},
          context: undefined,
        });
      }

      const tools = (
        settings as {
          readonly tools: Record<
            string,
            {
              execute: (
                input: unknown,
                options: { readonly toolCallId: string },
              ) => Promise<unknown>;
            }
          >;
        }
      ).tools;
      const tool = tools[toolName];

      if (tool === undefined) {
        throw new Error(`Missing test tool "${toolName}".`);
      }

      const output = await tool.execute(args, { toolCallId: `call-${toolName}` });

      const result = {
        finishReason: "stop",
        response: { messages: [{ content: String(output), role: "assistant" }] },
        text: String(output),
        toolCalls: [],
        toolResults: [],
        usage: undefined,
      };

      if (onStepFinish) await onStepFinish(result);
      return { ...result, responseMessages: result.response.messages };
    });

    return this as unknown as ToolLoopAgent;
  } as unknown as ConstructorParameters<typeof ToolLoopAgent> extends [infer S]
    ? (settings: S) => ToolLoopAgent
    : never);
}

function setupMockAgentForToolCall(toolName: string, args: unknown): void {
  vi.mocked(ToolLoopAgent).mockImplementation(function (
    this: Record<string, unknown>,
    settings: Record<string, unknown>,
  ) {
    const prepareStep = settings.prepareStep as
      | ((...args: unknown[]) => Promise<unknown>)
      | undefined;
    const onStepFinish = settings.onStepFinish as
      | ((...args: unknown[]) => Promise<unknown>)
      | undefined;

    this.generate = vi.fn().mockImplementation(async (options: { messages: unknown[] }) => {
      if (prepareStep) {
        await prepareStep({
          context: undefined,
          messages: options.messages,
          model: {},
          stepNumber: 0,
          steps: [],
        });
      }

      const result = {
        content: [
          {
            input: args,
            toolCallId: "call-subagent-1",
            toolName,
            type: "tool-call",
          },
        ],
        finishReason: "tool-calls",
        response: {
          messages: [
            {
              content: [
                {
                  input: args,
                  toolCallId: "call-subagent-1",
                  toolName,
                  type: "tool-call",
                },
              ],
              role: "assistant",
            },
          ],
        },
        text: undefined,
        toolCalls: [
          {
            input: args,
            toolCallId: "call-subagent-1",
            toolName,
            type: "tool-call",
          },
        ],
        toolResults: [],
        usage: undefined,
      };

      if (onStepFinish) {
        await onStepFinish(result);
      }

      return { ...result, responseMessages: result.response.messages };
    });

    return this as unknown as ToolLoopAgent;
  } as unknown as ConstructorParameters<typeof ToolLoopAgent> extends [infer S]
    ? (settings: S) => ToolLoopAgent
    : never);
}

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
    hookRegistry: createEmptyHookRegistry(),
    nodeId: ROOT_RUNTIME_AGENT_NODE_ID,
    rootCapabilities: { tasks: false },
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
  readonly tasks?: boolean;
  readonly turnTools?: StaticRuntimeTurnAgent["tools"];
}): Promise<ResolvedRuntimeAgentNode> {
  const toolRegistry = await createRuntimeToolRegistry({
    tools: input.names.map((name) => ({
      description: `${name} programmatic tool.`,
      execute: async () => `${name}-sentinel`,
      inputSchema: null,
      logicalPath: `tools/${name}.ts`,
      name,
      owner: { feature: "test", kind: "framework" },
      sourceId: `framework:tools/${name}.ts`,
      sourceKind: "module",
    })),
  });
  const node = createTestNode(
    createTestTurnAgent({
      tools: [...toolRegistry.preparedTools, ...(input.turnTools ?? [])],
    }),
    { toolRegistry },
  );
  return {
    ...node,
    rootCapabilities: { tasks: input.tasks === true },
    agent: {
      ...node.agent,
      config: {
        model: { id: "test-model" },
        name: "test",
      },
    },
  };
}

function createNoopRuntime(): Runtime {
  return {
    createSession: vi
      .fn()
      .mockRejectedValue(new Error("runtime.createSession should not be called in this test")),
    dispatchContinuation: vi.fn(),
    dispatchSession: vi.fn(),
    getEventStream: vi
      .fn()
      .mockRejectedValue(new Error("runtime.getEventStream should not be called in this test")),
    getStreamTailIndex: vi
      .fn()
      .mockRejectedValue(new Error("runtime.getStreamTailIndex should not be called in this test")),
    resolveContinuation: vi.fn(),
  };
}

describe("createNodeHarnessTools", () => {
  it("keeps the compiled framework question tool client-side", async () => {
    const node = await createNodeWithSourceOwnedTools({ names: ["ask_question"] });

    expect(createNodeHarnessTools({ node }).get("ask_question")?.execute).toBeUndefined();
  });

  it("lowers the compiled framework agent tool to the canonical dispatch action", async () => {
    const node = await createNodeWithSourceOwnedTools({ names: ["agent"] });
    const agentTool = createNodeHarnessTools({ node }).get("agent");

    expect(agentTool?.description).toContain("split a large task into independent pieces");
    expect(agentTool?.description).toContain("multiple `agent` calls in one response");
    expect(agentTool?.description).toContain("run a small fixed set in parallel");
    expect(agentTool?.description).toContain("include essential context");
    expect(agentTool?.description).toContain("non-overlapping scopes");
    expect(agentTool?.description).not.toContain("eve");
    expect(agentTool?.runtimeAction).toEqual({
      kind: "subagent-call",
      nodeId: ROOT_RUNTIME_AGENT_NODE_ID,
      subagentName: "agent",
    });
  });

  it("omits compiled task-control tools unless experimental.tasks is on", async () => {
    const node = await createNodeWithSourceOwnedTools({
      names: ["task_cancel", "task_update"],
    });
    const tools = createNodeHarnessTools({ node });

    for (const name of ["task_cancel", "task_update"]) {
      expect(tools.has(name)).toBe(false);
    }
  });

  it("lowers compiled task-control tools when experimental.tasks is on", async () => {
    const tools = createNodeHarnessTools({
      node: await createNodeWithSourceOwnedTools({
        names: ["task_cancel", "task_update"],
        tasks: true,
      }),
    });

    for (const name of ["task_cancel", "task_update"]) {
      expect(tools.get(name)?.runtimeAction).toEqual({ kind: "task-control" });
      expect(tools.get(name)?.execute).toBeUndefined();
    }
    expect(tools.has("task_sleep")).toBe(false);
  });

  it("uses projected root tasks on a child whose config has no task setting", async () => {
    const node = await createNodeWithSourceOwnedTools({
      names: ["task_cancel"],
      tasks: true,
    });
    expect(node.agent.config?.experimental?.tasks).toBeUndefined();
    expect(createNodeHarnessTools({ node }).get("task_cancel")?.runtimeAction).toEqual({
      kind: "task-control",
    });
  });

  it("executes compiled local and remote delegation tools in the selected task mode", async () => {
    const delegationTools: StaticRuntimeTurnAgent["tools"] = [
      {
        description: "Delegate local research.",
        inputSchema: { type: "object" },
        kind: "subagent",
        logicalPath: "subagents/research",
        name: "research",
        nodeId: "subagents/research",
        sourceId: "subagents/research",
      },
      {
        description: "Delegate remote review.",
        inputSchema: { type: "object" },
        kind: "remote",
        logicalPath: "remote-agents/reviewer",
        name: "reviewer",
        nodeId: "remote-agents/reviewer",
        sourceId: "remote-agents/reviewer",
      },
    ];
    const legacy = createNodeHarnessTools({
      node: await createNodeWithSourceOwnedTools({
        names: ["agent"],
        turnTools: delegationTools,
      }),
    });
    expect(legacy.get("research")?.runtimeAction?.kind).toBe("subagent-call");
    expect(legacy.get("reviewer")?.runtimeAction?.kind).toBe("remote-agent-call");
    expect(legacy.get("research")?.execution).toBeUndefined();
    expect(legacy.get("reviewer")?.execution).toBeUndefined();

    const background = createNodeHarnessTools({
      node: await createNodeWithSourceOwnedTools({
        names: ["agent"],
        tasks: true,
        turnTools: delegationTools,
      }),
    });
    for (const name of ["agent", "research", "reviewer"]) {
      expect(background.get(name)?.execution).toBe("background");
      expect(background.get(name)?.execute).toBeDefined();
      expect(background.get(name)?.runtimeAction).toBeUndefined();
    }
    expect(
      countLocalSubagentCalls(
        ["agent", "research", "reviewer"].map((name) => {
          const execute = background.get(name)?.execute;
          if (execute === undefined) throw new Error(`Missing background executor for ${name}.`);
          return { definition: { execute } };
        }),
      ),
    ).toBe(2);
  });

  it("does not recreate task tools absent from the compiled graph", async () => {
    const tools = createNodeHarnessTools({
      node: await createNodeWithSourceOwnedTools({ names: ["task_update"], tasks: true }),
    });

    expect(tools.has("task_update")).toBe(true);
    expect(tools.has("task_cancel")).toBe(false);
  });
});

describe("createExecutionNodeStep", () => {
  it("builds a usable harness step for the root node", async () => {
    setupMockAgentForToolExecution("regular-tool", { question: "Run the tool." });

    const toolRegistry = await createRuntimeToolRegistry({
      tools: [
        {
          description: "A regular tool.",
          execute: async () => "tool-output",
          inputSchema: toInputSchema({ type: "object" }),
          logicalPath: "tools/regular-tool.ts",
          name: "regular-tool",
          owner: { kind: "application" },
          sourceId: "tools/regular-tool.ts",
          sourceKind: "module",
        },
      ],
    });
    const rootNode = createTestNode(
      createTestTurnAgent({
        tools: toolRegistry.preparedTools,
      }),
      {
        toolRegistry,
      },
    );
    const modelResolutionScope = {
      moduleMap: { nodes: {} },
      nodeId: undefined,
    };
    const step = createExecutionNodeStep({
      createRuntime: () => createNoopRuntime(),
      mode: "task",
      modelResolutionScope,
      node: rootNode,
    });

    const ctx = new ContextContainer();
    ctx.set(AuthKey, null);
    ctx.set(InitiatorAuthKey, null);
    ctx.set(BundleKey, {
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
    } as never);
    ctx.set(ChannelKey, { kind: "http" });
    ctx.set(SessionIdKey, "sess-root");
    ctx.set(SessionKey, {
      auth: { current: null, initiator: null },
      sessionId: "sess-root",
      turn: { id: "root-turn", sequence: 0 },
    });

    const result = await contextStorage.run(ctx, () =>
      step(
        createSession({
          continuationToken: "test-root",
          sessionId: "sess-root",
          turnAgent: rootNode.turnAgent,
        }),
        {
          message: "Run the tool.",
        },
      ),
    );

    expect(result.next).toEqual({ done: true, output: "tool-output" });
    expect(resolveRuntimeModelReference).toHaveBeenCalledWith(
      rootNode.turnAgent.model,
      modelResolutionScope,
    );
  });

  it("records visible subagent tools as pending runtime actions", async () => {
    setupMockAgentForToolCall("child-agent", { task: "Delegate this." });

    const createRuntime = vi.fn();

    const testCompiledArtifactsSource = createBundledRuntimeCompiledArtifactsSource();
    const rootNode = createTestNode(
      createTestTurnAgent({
        tools: [
          {
            description: "Delegate work to the child agent.",
            inputSchema: { type: "object" },
            kind: "subagent",
            logicalPath: "subagents/child",
            name: "child-agent",
            nodeId: "child-node",
            sourceId: "subagents/child",
          },
        ],
      }),
    );
    const step = createExecutionNodeStep({
      createRuntime,
      mode: "task",
      modelResolutionScope: {
        moduleMap: { nodes: {} },
        nodeId: undefined,
      },
      node: rootNode,
    });

    const ctx = new ContextContainer();
    ctx.set(AuthKey, null);
    ctx.set(InitiatorAuthKey, null);
    ctx.set(BundleKey, { compiledArtifactsSource: testCompiledArtifactsSource } as never);
    ctx.set(ChannelKey, { kind: "http" });
    ctx.set(SessionIdKey, "parent-session");
    ctx.set(SessionKey, {
      auth: { current: null, initiator: null },
      sessionId: "parent-session",
      turn: { id: "parent-turn", sequence: 0 },
    });

    const result = await contextStorage.run(ctx, async () =>
      step(
        createSession({
          continuationToken: "test-root",
          sessionId: "sess-root",
          turnAgent: rootNode.turnAgent,
        }),
        {
          message: "Delegate this.",
        },
      ),
    );

    expect(result.next).toBeNull();
    expect(createRuntime).not.toHaveBeenCalled();
    expect(getPendingRuntimeActionBatch(result.session.state)).toEqual({
      actions: [
        {
          callId: "call-subagent-1",
          description: "Delegate work to the child agent.",
          input: { task: "Delegate this." },
          kind: "subagent-call",
          name: "child-agent",
          nodeId: "child-node",
          subagentName: "child-agent",
        },
      ],
      event: {
        sequence: 0,
        stepIndex: 0,
        turnId: "",
      },
      responseMessages: [
        {
          content: [
            {
              input: { task: "Delegate this." },
              toolCallId: "call-subagent-1",
              toolName: "child-agent",
              type: "tool-call",
            },
          ],
          role: "assistant",
        },
      ],
    });
  });
});
