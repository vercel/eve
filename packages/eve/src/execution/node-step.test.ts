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
import { createSession } from "#execution/session.js";
import { createStubSandboxRegistry } from "#internal/testing/stub-sandbox-registry.js";

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

function createTestTurnAgent(overrides?: Partial<RuntimeTurnAgent>): RuntimeTurnAgent {
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
    agent: {
      ...agent,
      disabledFrameworkTools: [],
    },
    channels: [],
    hookRegistry: createEmptyHookRegistry(),
    nodeId: ROOT_RUNTIME_AGENT_NODE_ID,
    sandboxRegistry: createStubSandboxRegistry(),
    subagentRegistry: {
      preparedTools: [],
      subagentsByName: new Map(),
      subagentsByNodeId: new Map(),
    },
    toolRegistry: createEmptyToolRegistry(),
    turnAgent: turnAgent ?? createTestTurnAgent(),
    ...overrides,
  };
}

function createNoopRuntime(): Runtime {
  return {
    cancelTurn: vi.fn(),
    deliver: vi.fn(),
    resolveSession: vi.fn(),
    run: vi.fn().mockRejectedValue(new Error("runtime.run should not be called in this test")),
    getEventStream: vi
      .fn()
      .mockRejectedValue(new Error("runtime.getEventStream should not be called in this test")),
  };
}

describe("createNodeHarnessTools", () => {
  it("guides the model to split large tasks across parallel agent calls", () => {
    const agentTool = createNodeHarnessTools({ node: createTestNode() }).get("agent");

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

  it("does not give declared subagent nodes the built-in agent tool", () => {
    const tools = createNodeHarnessTools({
      node: createTestNode(undefined, { nodeId: "subagents/researcher" }),
    });

    expect(tools.has("agent")).toBe(false);
  });

  it("does not give the root node the built-in agent tool when it is disabled", () => {
    const node = createTestNode();
    const tools = createNodeHarnessTools({
      node: {
        ...node,
        agent: {
          ...node.agent,
          disabledFrameworkTools: ["agent"],
        },
      },
    });

    expect(tools.has("agent")).toBe(false);
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
          inputSchema: { type: "object" },
          logicalPath: "tools/regular-tool.ts",
          name: "regular-tool",
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
