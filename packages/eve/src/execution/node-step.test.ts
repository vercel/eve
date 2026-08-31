import { ToolLoopAgent } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "#channel/types.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey, InitiatorAuthKey, SessionIdKey, SessionKey } from "#context/keys.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { getPendingRuntimeActionBatch } from "#harness/runtime-actions.js";
import { createInstrumentationHooks } from "#instrumentation/lifecycle.js";
import {
  bindInstrumentationRuntime,
  type InstrumentationRuntime,
} from "#instrumentation/runtime.js";
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
import { AGENT_TOOL_DESCRIPTION } from "#tools/framework/agent-contract.js";

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
  const sandboxRegistry = createStubSandboxRegistry();
  const agent: ResolvedRuntimeAgentNode["agent"] = {
    channels: [],
    connections: [],
    dynamicConnectionResolvers: [],
    dynamicInstructionsResolvers: [],
    dynamicSkillResolvers: [],
    dynamicToolResolvers: [],
    hooks: [],
    instructions: [],
    memories: [],
    metadata: {
      agentRoot: "",
      appRoot: "",
      diagnosticsSummary: { errors: 0, warnings: 0 },
    },
    sandbox: sandboxRegistry.sandbox.definition,
    skills: [],
    tools: [],
    workspaceResourceRoot: sandboxRegistry.sandbox.workspaceResourceRoot,
    workspaceSpec: { rootEntries: [] },
  };

  return {
    agent,
    channels: [],
    hookRegistry: createEmptyHookRegistry(),
    nodeId: ROOT_RUNTIME_AGENT_NODE_ID,
    sandboxRegistry,
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
  const toolRegistry = await createRuntimeToolRegistry(
    {
      tools: input.names.map((name) => ({
        behavior:
          name === "agent"
            ? {
                availability: ["root-session"],
                handling: { action: "self-agent", kind: "dispatch" },
              }
            : name === "ask_question"
              ? {
                  availability: ["requires-request-input"],
                  handling: { kind: "request-input", request: "question" },
                }
              : name === "task_cancel"
                ? {
                    availability: ["root-session"],
                    handling: { action: "task-cancel", kind: "dispatch" },
                  }
                : {
                    availability: ["delegated-task-child"],
                    handling: { action: "task-update", kind: "dispatch" },
                  },
        description: name === "agent" ? AGENT_TOOL_DESCRIPTION : `${name} programmatic tool.`,
        inputSchema: null,
        logicalPath: `tools/${name}.ts`,
        name,
        owner: { feature: "test", kind: "framework" },
        sourceId: `framework:tools/${name}.ts`,
        sourceKind: "module",
      })),
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
        experimental: { tasks: input.tasks === true },
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
    expect(agentTool?.behavior?.handling).toEqual({
      kind: "dispatch",
      target: {
        kind: "self-agent-call",
        nodeId: ROOT_RUNTIME_AGENT_NODE_ID,
        subagentName: "agent",
      },
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
      expect(tools.get(name)?.behavior?.handling).toEqual({
        kind: "dispatch",
        target: { kind: name === "task_cancel" ? "task-cancel" : "task-update" },
      });
      expect(tools.get(name)?.execute).toBeUndefined();
    }
    expect(tools.has("task_sleep")).toBe(false);
  });

  it("executes compiled local and remote delegation tools in the selected task mode", async () => {
    const delegationTools: StaticRuntimeTurnAgent["tools"] = [
      {
        behavior: {
          availability: [],
          handling: {
            kind: "dispatch",
            target: {
              kind: "subagent-call",
              nodeId: "subagents/research",
              subagentName: "research",
            },
          },
        },
        description: "Delegate local research.",
        inputSchema: { type: "object" },
        kind: "subagent",
        logicalPath: "subagents/research",
        name: "research",
        nodeId: "subagents/research",
        sourceId: "subagents/research",
      },
      {
        behavior: {
          availability: [],
          handling: {
            kind: "dispatch",
            target: {
              kind: "remote-agent-call",
              nodeId: "remote-agents/reviewer",
              remoteAgentName: "reviewer",
            },
          },
        },
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
    expect(legacy.get("research")?.behavior?.handling).toMatchObject({
      kind: "dispatch",
      target: { kind: "subagent-call" },
    });
    expect(legacy.get("reviewer")?.behavior?.handling).toMatchObject({
      kind: "dispatch",
      target: { kind: "remote-agent-call" },
    });
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
      expect(background.get(name)?.behavior?.handling?.kind).toBe("dispatch");
    }
    expect(
      countLocalSubagentCalls(
        ["agent", "research", "reviewer"].map((name) => {
          const definition = background.get(name);
          if (definition?.execute === undefined) {
            throw new Error(`Missing background executor for ${name}.`);
          }
          return { definition };
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
    const forceFlush = vi.fn(async () => undefined);
    const runtime: InstrumentationRuntime = {
      forceFlush,
      hooks: createInstrumentationHooks([]),
      otelSettings: undefined,
      runInContext: (_operation, execute) => execute(),
      shutdown: async () => undefined,
    };
    const instrumentation = bindInstrumentationRuntime(runtime, new ContextContainer(), {
      agentName: "test-agent",
      rootSessionId: "sess-root",
      sessionId: "sess-root",
    });

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
      instrumentation,
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
    expect(forceFlush).toHaveBeenCalledOnce();
  });

  it("records visible subagent tools as pending runtime actions", async () => {
    setupMockAgentForToolCall("child-agent", { task: "Delegate this." });

    const createRuntime = vi.fn();

    const testCompiledArtifactsSource = createBundledRuntimeCompiledArtifactsSource();
    const rootNode = createTestNode(
      createTestTurnAgent({
        tools: [
          {
            behavior: {
              availability: [],
              handling: {
                kind: "dispatch",
                target: {
                  kind: "subagent-call",
                  nodeId: "child-node",
                  subagentName: "child-agent",
                },
              },
            },
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
      instrumentation: undefined,
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
          target: {
            kind: "subagent-call",
            nodeId: "child-node",
            subagentName: "child-agent",
          },
          toolName: "child-agent",
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
