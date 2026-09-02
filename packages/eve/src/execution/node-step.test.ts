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
import { createRequests } from "#harness/input-requests.js";
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
import { defineTool } from "#tools/definition.js";
import { stampDurableDynamicCallback } from "#tools/durable-callbacks.js";
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
  it("keeps the instrumentation drain on the root harness-step critical path", async () => {
    setupMockAgentForToolExecution("regular-tool", { question: "Run the tool." });
    const flush = Promise.withResolvers<void>();
    const forceFlush = vi.fn(() => flush.promise);
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

    let stepSettled = false;
    const resultPromise = contextStorage
      .run(ctx, () =>
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
      )
      .finally(() => {
        stepSettled = true;
      });

    await vi.waitFor(() => expect(forceFlush).toHaveBeenCalledOnce());
    expect(stepSettled).toBe(false);
    flush.resolve();
    const result = await resultPromise;

    expect(result.next).toEqual({ done: true, output: "tool-output" });
    expect(resolveRuntimeModelReference).toHaveBeenCalledWith(
      rootNode.turnAgent.model,
      modelResolutionScope,
    );
    expect(stepSettled).toBe(true);
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
    const stepInput = {
      createRuntime: () => createNoopRuntime(),
      instrumentation: undefined,
      mode: "task" as const,
      modelResolutionScope: { moduleMap: { nodes: {} }, nodeId: undefined },
      node,
    };
    const step = createExecutionNodeStep(stepInput);

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
    const session = createRequests({
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

  it("always advertises load_skill when the node has no compiled skills", async () => {
    setupMockAgentForToolExecution("load_skill", { skill: "deploy-note" });
    const toolRegistry = await createRuntimeToolRegistry({
      tools: [
        {
          behavior: {
            availability: [],
            presentation: "load-skill",
          },
          description: "Load one skill.",
          execute: async () => "deploy-note instructions",
          inputSchema: toInputSchema({ type: "object" }),
          logicalPath: "tools/load_skill.ts",
          name: "load_skill",
          owner: { feature: "load-skill", kind: "framework" },
          sourceId: "framework:tools/load_skill.ts",
          sourceKind: "module",
        },
      ],
    });
    const rootNode = createTestNode(createTestTurnAgent({ tools: toolRegistry.preparedTools }), {
      toolRegistry,
    });
    expect(rootNode.agent.skills).toEqual([]);
    const step = createExecutionNodeStep({
      createRuntime: () => createNoopRuntime(),
      instrumentation: undefined,
      mode: "task",
      modelResolutionScope: { moduleMap: { nodes: {} }, nodeId: undefined },
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
        { message: "Load the deploy note skill." },
      ),
    );

    expect(result.next).toEqual({ done: true, output: "deploy-note instructions" });
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
