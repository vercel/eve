import { ToolLoopAgent } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "#channel/types.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import type { OldSourceOffsetDynamicToolMetadata } from "#context/dynamic-tool-metadata.js";
import {
  AuthKey,
  InitiatorAuthKey,
  SessionIdKey,
  SessionKey,
  StepDynamicToolMetadataKey,
} from "#context/keys.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { appendPendingInputBatch } from "#harness/input-requests.js";
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
import { createPreparedRuntimeSubagentTool } from "#runtime/subagents/registry.js";
import { createExecutionNodeStep, createNodeHarnessTools } from "#execution/node-step.js";
import { createSession } from "#execution/session.js";
import { createStubSandboxRegistry } from "#internal/testing/stub-sandbox-registry.js";
import { defineTool } from "#tools/definition.js";
import { stampDurableDynamicCallback } from "#tools/durable-callbacks.js";
import { toInputSchema } from "#tools/schema.js";
import {
  AGENT_TOOL_DESCRIPTION,
  AGENT_TOOL_NAME,
  SUBAGENT_TOOL_INPUT_SCHEMA,
} from "#tools/framework/agent-contract.js";

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
  const toolRegistry = await createRuntimeToolRegistry({
    tools: input.names.map((name) => ({
      description: name === AGENT_TOOL_NAME ? AGENT_TOOL_DESCRIPTION : `${name} programmatic tool.`,
      execute: async () => `${name}-sentinel`,
      execution: name === AGENT_TOOL_NAME ? "background" : undefined,
      inputSchema: name === AGENT_TOOL_NAME ? SUBAGENT_TOOL_INPUT_SCHEMA : null,
      logicalPath: `tools/${name}.ts`,
      name,
      owner: input.owner ?? { feature: "test", kind: "framework" },
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
  it("adds the framework label start callback to provider-managed web search", async () => {
    const node = await createNodeWithSourceOwnedTools({ names: ["web_search"] });
    const tool = createNodeHarnessTools({ node }).get("web_search");

    expect(tool?.label?.start?.({ query: "Slack plan blocks" })).toBe("Search Slack plan blocks");
  });

  it("does not add the framework label to an authored web_search override", async () => {
    const node = await createNodeWithSourceOwnedTools({
      names: ["web_search"],
      owner: { kind: "application" },
    });

    expect(createNodeHarnessTools({ node }).get("web_search")?.label).toBeUndefined();
  });

  it("keeps the compiled framework question tool client-side", async () => {
    const node = await createNodeWithSourceOwnedTools({ names: ["ask_question"] });

    expect(createNodeHarnessTools({ node }).get("ask_question")?.execute).toBeUndefined();
  });

  it("lowers the compiled framework agent tool as a background tool", async () => {
    const node = await createNodeWithSourceOwnedTools({ names: ["agent"] });
    const agentTool = createNodeHarnessTools({ node }).get("agent");

    expect(agentTool?.description).toContain("split a large task into independent pieces");
    expect(agentTool?.description).toContain("multiple `agent` calls in one response");
    expect(agentTool?.description).toContain("run a small fixed set in parallel");
    expect(agentTool?.description).toContain("include essential context");
    expect(agentTool?.description).toContain("non-overlapping scopes");
    expect(agentTool?.description).not.toContain("eve");
    expect(agentTool?.execution).toBe("background");
    expect(agentTool?.runtimeAction).toBeUndefined();
    expect(agentTool?.execute).toBeDefined();
  });

  it("lowers compiled task-control tools from their framework definitions", async () => {
    const node = await createNodeWithSourceOwnedTools({
      names: ["task_cancel", "task_update"],
    });
    const tools = createNodeHarnessTools({ node });

    for (const name of ["task_cancel", "task_update"]) {
      expect(tools.get(name)?.runtimeAction).toEqual({ kind: "task-control" });
      expect(tools.get(name)?.execute).toBeUndefined();
    }
    expect(tools.has("task_sleep")).toBe(false);
  });

  it("executes compiled local and remote delegation tools as background tasks", async () => {
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
      expect(tools.get(name)?.execution).toBe("background");
      expect(tools.get(name)?.execute).toBeDefined();
      expect(tools.get(name)?.runtimeAction).toBeUndefined();
      expect(tools.get(name)?.resultKind).toBe("subagent");
      expect(tools.get(name)?.workflowId).toBe("workflow//eve//subagentToolExecuteWorkflow");
    }
  });

  it("does not recreate task tools absent from the compiled graph", async () => {
    const tools = createNodeHarnessTools({
      node: await createNodeWithSourceOwnedTools({ names: ["task_update"] }),
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
  });

  it("prepares persisted step tools with the node's dynamic resolvers", async () => {
    const executeCallback = vi.fn(async (closure: unknown) => {
      return (closure as { version: string }).version;
    });
    const handler = vi.fn(() => ({
      wired_dynamic_tool: defineTool({
        approval: stampDurableDynamicCallback(() => "user-approval" as const, {
          callback: () => "user-approval" as const,
          closure: { version: "current-request" },
        }),
        description: "A dynamic tool.",
        execute: stampDurableDynamicCallback(async () => "current-execute", {
          callback: executeCallback,
          closure: { version: "current-execute" },
        }),
        inputSchema: { type: "object" },
      }),
    }));
    const dynamicToolResolver = {
      eventNames: ["step.started"],
      events: { "step.started": handler },
      logicalPath: "agent/tools/wired.ts",
      slug: "wired",
      sourceId: "test:wired-dynamic-tool",
      sourceKind: "module",
    } as never;
    const baseNode = createTestNode();
    const node = {
      ...baseNode,
      agent: {
        ...baseNode.agent,
        dynamicToolResolvers: [dynamicToolResolver],
      },
    };
    setupMockAgentForToolExecution("wired_dynamic_tool", {});
    const step = createExecutionNodeStep({
      createRuntime: () => createNoopRuntime(),
      instrumentation: undefined,
      mode: "task",
      modelResolutionScope: { moduleMap: { nodes: {} }, nodeId: undefined },
      node,
    });

    const responder = {
      attributes: {},
      authenticator: "test",
      issuer: "test",
      principalId: "user-1",
      principalType: "user" as const,
    };
    const ctx = new ContextContainer();
    ctx.set(AuthKey, responder);
    ctx.set(InitiatorAuthKey, null);
    ctx.set(BundleKey, {
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
    } as never);
    ctx.set(ChannelKey, { kind: "http" });
    ctx.set(SessionIdKey, "sess-dynamic");
    ctx.set(SessionKey, {
      auth: { current: responder, initiator: null },
      sessionId: "sess-dynamic",
      turn: { id: "turn-1", sequence: 1 },
    });
    ctx.set(StepDynamicToolMetadataKey, [
      {
        callbacks: {
          approvalRequest: {
            closure: { version: "persisted-request" },
            stepId: "eve:dynamic-tool//old/approval-request/0-100",
          },
          execute: {
            closure: { version: "persisted-execute" },
            stepId: "eve:dynamic-tool//old/execute/0-100",
          },
        },
        description: "Old dynamic tool.",
        entryKey: "wired_dynamic_tool",
        inputSchema: { type: "object" },
        name: "wired_dynamic_tool",
        resolverSlug: "wired",
      } satisfies OldSourceOffsetDynamicToolMetadata,
    ]);
    const session = appendPendingInputBatch({
      requests: [
        {
          action: {
            callId: "call-wired",
            input: {},
            kind: "tool-call",
            toolName: "wired_dynamic_tool",
          },
          allowFreeform: false,
          display: "confirmation",
          kind: "tool-approval",
          options: [
            { id: "approve", label: "Approve" },
            { id: "cancel", label: "Cancel" },
          ],
          prompt: "Approve dynamic tool",
          requestId: "approval-wired",
        },
      ],
      responseMessages: [
        {
          content: [
            {
              input: {},
              toolCallId: "call-wired",
              toolName: "wired_dynamic_tool",
              type: "tool-call",
            },
            {
              approvalId: "approval-wired",
              toolCallId: "call-wired",
              type: "tool-approval-request",
            },
          ],
          role: "assistant",
        },
      ],
      session: createSession({
        continuationToken: "test-dynamic",
        sessionId: "sess-dynamic",
        turnAgent: node.turnAgent,
      }),
    });

    await contextStorage.run(ctx, () =>
      step(session, {
        attributedInputResponses: [
          {
            auth: responder,
            response: { optionId: "approve", requestId: "approval-wired" },
          },
        ],
      }),
    );

    expect(handler).toHaveBeenCalledOnce();
    expect(executeCallback).toHaveBeenCalledWith(
      { version: "persisted-execute" },
      {},
      expect.objectContaining({ callId: "call-wired_dynamic_tool" }),
    );
  });
});
