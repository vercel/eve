import { context as otelContext, trace } from "#compiled/@opentelemetry/api/index.js";
import {
  type FilePart,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  ToolLoopAgent,
  type UserContent,
} from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import {
  AuthKey,
  ChannelInstrumentationKey,
  InitiatorAuthKey,
  LiveStepDynamicModelSelectionKey,
  LiveStepToolsKey,
  ParentSessionKey,
  SandboxKey,
  SessionKey,
  SessionDynamicInstructionsKey,
  SessionDynamicModelReferenceKey,
} from "#context/keys.js";
import { SCHEDULE_APP_AUTH } from "#channel/schedule-auth.js";
import { decodeSandboxRef, isSandboxRefUrl } from "#internal/attachments/sandbox-refs.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import type { InstrumentationStepStartedEventInput } from "#public/instrumentation/index.js";
import type { RunMode } from "#shared/run-mode.js";
import { compactMessages, shouldCompact } from "#harness/compaction.js";
import { getHarnessEmissionState, isHarnessBetweenTurns } from "#harness/emission.js";
import {
  getPendingAuthorization,
  modelFacingAuthorizationOutput,
  requestAuthorization,
} from "#harness/authorization.js";
import { hasDeferredStepInput, setPendingInputBatch } from "#harness/input-requests.js";
import { getPendingRuntimeActionBatch } from "#harness/runtime-actions.js";
import { stashToolInterrupt } from "#harness/tool-interrupts.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import { TurnCancelledError } from "#harness/turn-cancellation.js";
import {
  getSessionTokenLimitViolation,
  getSessionTokenUsage,
  setTurnUsageState,
} from "#harness/turn-tag-state.js";
import { DEFAULT_SUBAGENT_MAX_DEPTH } from "#harness/subagent-depth.js";
import type { HarnessEmitFn, HarnessSession, ToolLoopHarnessConfig } from "#harness/types.js";
import {
  CONDITIONAL_DELIVERY_INSTRUCTION,
  EMPTY_DELIVERY_SENTINEL,
} from "#shared/empty-delivery.js";

declare module "#public/channels/index.js" {
  interface ChannelMetadataMap {
    readonly "channel:support": {
      readonly triggeringUserId: string | null;
    } & Readonly<Record<string, unknown>>;
  }
}

vi.mock("ai", () => ({
  ToolLoopAgent: vi.fn(),
  gateway: {
    tools: {
      parallelSearch: vi.fn(() => ({})),
    },
  },
  jsonSchema: vi.fn((s: unknown) => s),
  isStepCount: vi.fn((n: number) => n),
  tool: vi.fn((t: unknown) => t),
}));

vi.mock("./otel-integration.js", () => ({
  ensureOtelIntegration: vi.fn(),
}));

const mockGetInstrumentationConfig = vi.fn().mockReturnValue(undefined);
vi.mock("./instrumentation-config.js", () => ({
  getInstrumentationConfig: (...args: unknown[]) => mockGetInstrumentationConfig(...args),
}));

vi.mock("./compaction.js", () => ({
  compactMessages: vi.fn(),
  estimateTokens: vi.fn().mockReturnValue(5000),
  getInputTokenCount: vi.fn().mockReturnValue(5000),
  resolveCompactionModel: vi.fn(
    async ({ compactionModelReference, model, modelReference, resolveModel }) => ({
      model:
        compactionModelReference === undefined
          ? model
          : ((await resolveModel(compactionModelReference)) as LanguageModel),
      providerOptions: (compactionModelReference ?? modelReference).providerOptions,
    }),
  ),
  shouldCompact: vi.fn().mockReturnValue(false),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mockGetInstrumentationConfig.mockReturnValue(undefined);
});

function createTestSession(overrides?: Partial<HarnessSession>): HarnessSession {
  return {
    agent: {
      modelReference: { id: "test-model" },
      system: "You are a test assistant.",
      tools: [{ description: "Adds numbers", name: "add", inputSchema: { type: "object" } }],
    },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:test-session",
    history: [],
    sessionId: "test-session",
    ...overrides,
  };
}

function createTestConfig(
  mode: RunMode = "conversation",
  emit?: HarnessEmitFn,
  overrides?: Partial<ToolLoopHarnessConfig>,
): ToolLoopHarnessConfig {
  return {
    handleEvent: emit,
    mode,
    resolveModel: vi.fn().mockResolvedValue({} as LanguageModel),
    tools: new Map([
      [
        "add",
        {
          description: "Adds numbers",
          execute: vi.fn().mockResolvedValue("42"),
          inputSchema: jsonSchema({ type: "object" }),
          name: "add",
        },
      ],
    ]),
    ...overrides,
  };
}

function createDelegationToolMap(): ToolLoopHarnessConfig["tools"] {
  return new Map([
    [
      "add",
      {
        description: "Adds numbers",
        execute: vi.fn().mockResolvedValue("42"),
        inputSchema: jsonSchema({ type: "object" }),
        name: "add",
      },
    ],
    [
      "delegate",
      {
        description: "Delegate to a subagent.",
        inputSchema: jsonSchema({ type: "object" }),
        name: "delegate",
        runtimeAction: {
          kind: "subagent-call",
          nodeId: "workers",
          subagentName: "worker",
        },
      },
    ],
  ]);
}

function createScheduleContext(): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(AuthKey, SCHEDULE_APP_AUTH);
  ctx.set(InitiatorAuthKey, SCHEDULE_APP_AUTH);
  return ctx;
}

function setDelegatedParent(ctx: ContextContainer): void {
  ctx.set(ParentSessionKey, {
    callId: "call-parent",
    rootSessionId: "session-root",
    sessionId: "session-parent",
    turn: { id: "turn-parent", sequence: 0 },
  });
}

function createEventCollector(): {
  emit: HarnessEmitFn;
  events: HandleMessageStreamEvent[];
} {
  const events: HandleMessageStreamEvent[] = [];
  const emit: HarnessEmitFn = async (event) => {
    events.push(event);
  };
  return { emit, events };
}

function getCompatibilityEventTypes(events: readonly HandleMessageStreamEvent[]): string[] {
  return events
    .filter((event) => event.type !== "message.appended" && event.type !== "reasoning.appended")
    .map((event) => event.type);
}

type PrepareStepProbe<TMessages, TResult> = (input: {
  context: unknown;
  messages: TMessages;
  model: unknown;
  stepNumber: number;
  steps: [];
}) => Promise<TResult>;

function getPrepareStep<TMessages, TResult>(value: unknown): PrepareStepProbe<TMessages, TResult> {
  expect(typeof value).toBe("function");
  return value as PrepareStepProbe<TMessages, TResult>;
}

function createMockStreamResult(result: Record<string, unknown>): {
  fullStream: AsyncIterable<Record<string, unknown>>;
  steps: Promise<Record<string, unknown>[]>;
} {
  const fullStreamParts = Array.isArray(result.fullStreamParts)
    ? (result.fullStreamParts as Array<Record<string, unknown>>)
    : null;

  return {
    fullStream:
      fullStreamParts === null
        ? createMockFullStream(result)
        : createExplicitMockFullStream(fullStreamParts),
    steps: Promise.resolve([result]),
  };
}

async function* createExplicitMockFullStream(
  parts: readonly Record<string, unknown>[],
): AsyncIterable<Record<string, unknown>> {
  for (const part of parts) {
    yield part;
  }
}

async function* createMockFullStream(
  result: Record<string, unknown>,
): AsyncIterable<Record<string, unknown>> {
  const toolCalls = Array.isArray(result.toolCalls)
    ? (result.toolCalls as Array<Record<string, unknown>>)
    : [];
  const toolCallsById = new Map(
    toolCalls.map((toolCall) => [String(toolCall.toolCallId), toolCall]),
  );
  const response = (result.response ?? {}) as { messages?: unknown };
  const responseMessages = Array.isArray(response.messages)
    ? (response.messages as Array<Record<string, unknown>>)
    : [];

  for (const message of responseMessages) {
    if (message.role === "assistant") {
      const content = message.content;

      if (typeof content === "string") {
        if (content.length > 0) {
          yield { id: "text-1", text: content, type: "text-delta" };
        }
        continue;
      }

      if (!Array.isArray(content)) {
        continue;
      }

      for (const part of content) {
        if (typeof part === "string") {
          if (part.length > 0) {
            yield { id: "text-1", text: part, type: "text-delta" };
          }
          continue;
        }

        if (part === null || typeof part !== "object" || !("type" in part)) {
          continue;
        }

        switch (part.type) {
          case "reasoning":
            yield { id: "reasoning-1", text: part.text, type: "reasoning-delta" };
            break;
          case "text":
            yield { id: "text-1", text: part.text, type: "text-delta" };
            break;
          case "tool-call":
            yield toolCallsById.get(String(part.toolCallId)) ?? (part as Record<string, unknown>);
            break;
          case "tool-approval-request": {
            const toolCall = toolCallsById.get(String(part.toolCallId));
            if (toolCall !== undefined) {
              yield {
                approvalId: part.approvalId,
                toolCall,
                type: "tool-approval-request",
              };
            }
            break;
          }
          default:
            break;
        }
      }

      continue;
    }

    if (message.role !== "tool" || !Array.isArray(message.content)) {
      continue;
    }

    for (const part of message.content) {
      if (part === null || typeof part !== "object" || !("type" in part)) {
        continue;
      }

      if (part.type === "tool-result") {
        yield part as Record<string, unknown>;
      }
    }
  }

  yield {
    finishReason: result.finishReason,
    type: "finish-step",
    usage: result.usage,
  };
}

type MockAgentSettings = {
  onStepFinish?: (step: unknown) => Promise<void> | void;
  output?: unknown;
  prepareStep?: (input: unknown) => Promise<unknown> | unknown;
};

type MockAgentConstructor =
  ConstructorParameters<typeof ToolLoopAgent> extends [infer S]
    ? (settings: S) => ToolLoopAgent
    : never;
type MockAgentInstance = ToolLoopAgent & Record<string, unknown>;

function setupMockAgent(result: Record<string, unknown>): void {
  vi.mocked(ToolLoopAgent).mockImplementation(function (
    this: Record<string, unknown>,
    settings: MockAgentSettings,
  ) {
    const { onStepFinish, prepareStep } = settings;

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
      if (onStepFinish) await onStepFinish(result);
      return result;
    });

    this.stream = vi.fn().mockImplementation(async (options: { messages: unknown[] }) => {
      if (prepareStep) {
        await prepareStep({
          messages: options.messages,
          steps: [],
          stepNumber: 0,
          model: {},
          context: undefined,
        });
      }
      const mockResult = createMockStreamResult(result);
      // Schedule onStepFinish to fire after a microtask so the stream
      // can start being consumed first by emitStreamContent.
      if (onStepFinish) {
        void Promise.resolve().then(() => onStepFinish(result));
      }
      return mockResult;
    });

    return this as unknown as ToolLoopAgent;
  } as unknown as MockAgentConstructor);
}

/**
 * Builds a terminal step result whose assistant turn calls the framework
 * `final_output` tool with `structured` as its (provider-constrained) input.
 */
function finalOutputResult(text: string, structured: unknown): Record<string, unknown> {
  return {
    finishReason: "stop",
    response: { messages: [{ content: text, role: "assistant" }] },
    text,
    toolCalls: [{ input: structured, toolCallId: "final-output-1", toolName: "final_output" }],
    toolResults: [],
  };
}

function createPendingBashApprovalSession(): HarnessSession {
  return setPendingInputBatch({
    requests: [
      {
        action: {
          callId: "call-1",
          input: { command: "pwd" },
          kind: "tool-call",
          toolName: "bash",
        },
        allowFreeform: false,
        display: "confirmation",
        options: [
          { id: "approve", label: "Yes" },
          { id: "deny", label: "No" },
        ],
        prompt: "Approve tool call: bash",
        requestId: "approval-1",
      },
    ],
    responseMessages: [
      {
        content: [
          {
            input: { command: "pwd" },
            toolCallId: "call-1",
            toolName: "bash",
            type: "tool-call",
          },
          {
            approvalId: "approval-1",
            toolCallId: "call-1",
            type: "tool-approval-request",
          },
        ],
        role: "assistant",
      },
    ],
    session: createTestSession({
      agent: {
        modelReference: { id: "anthropic/claude-opus-4.6" },
        system: "You are a test assistant.",
        tools: [
          { description: "Run shell commands", name: "bash", inputSchema: { type: "object" } },
        ],
      },
    }),
  });
}

function createPendingProtectedActionApprovalSession(): HarnessSession {
  return setPendingInputBatch({
    requests: [
      {
        action: {
          callId: "call-1",
          input: { action: "run" },
          kind: "tool-call",
          toolName: "protected_action",
        },
        allowFreeform: false,
        display: "confirmation",
        options: [
          { id: "approve", label: "Yes" },
          { id: "deny", label: "No" },
        ],
        prompt: "Approve tool call: protected_action",
        requestId: "approval-1",
      },
    ],
    responseMessages: [
      {
        content: [
          {
            input: { action: "run" },
            toolCallId: "call-1",
            toolName: "protected_action",
            type: "tool-call",
          },
          {
            approvalId: "approval-1",
            toolCallId: "call-1",
            type: "tool-approval-request",
          },
        ],
        role: "assistant",
      },
    ],
    session: createTestSession({
      agent: {
        modelReference: { id: "anthropic/claude-opus-4.6" },
        system: "You are a test assistant.",
        tools: [
          {
            description: "Run a protected action",
            name: "protected_action",
            inputSchema: { type: "object" },
          },
        ],
      },
    }),
  });
}

function setupMockAgentError(error: Error): void {
  vi.mocked(ToolLoopAgent).mockImplementation(function (
    this: Record<string, unknown>,
    _settings: MockAgentSettings,
  ) {
    this.generate = vi.fn().mockRejectedValue(error);
    this.stream = vi.fn().mockRejectedValue(error);
    return this as unknown as ToolLoopAgent;
  } as unknown as MockAgentConstructor);
}

function createGatewayModelCallError(input: {
  readonly gatewayName: string;
  readonly gatewayType: string;
  readonly upstreamType: string;
}): Error {
  const responseBody = JSON.stringify({
    error: {
      message: "Bad Request",
      type: input.upstreamType,
    },
    generationId: "gen_tool_loop",
  });
  const upstream = Object.assign(new Error("[object Object]"), {
    data: {
      error: {
        message: "Bad Request",
        type: input.upstreamType,
      },
      generationId: "gen_tool_loop",
    },
    isRetryable: false,
    name: "AI_APICallError",
    requestBodyValues: {
      tools: [{ inputSchema: { description: "large schema ".repeat(500) } }],
    },
    responseBody,
    statusCode: 400,
  });
  return Object.assign(new Error(`${input.gatewayName}: Bad Request`, { cause: upstream }), {
    generationId: "gen_tool_loop",
    isRetryable: false,
    name: input.gatewayName,
    statusCode: 400,
    type: input.gatewayType,
  });
}

describe("createToolLoopHarness", () => {
  it("parks when model finishes with stop", async () => {
    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "Hello!", role: "assistant" }] },
      text: "Hello!",
      toolCalls: [],
      toolResults: [],
    });

    const config = createTestConfig("conversation");
    const runStep = createToolLoopHarness(config);
    const session = createTestSession();

    const result = await runStep(session, { message: "Hi" });

    expect(result.next).toBeNull();
    expect(result.session.history).toEqual([
      { content: "Hi", role: "user" },
      { content: "Hello!", role: "assistant" },
    ]);
  });

  it("parks without delivery when a terminal response contains the empty-delivery sentinel", async () => {
    setupMockAgent({
      finishReason: "stop",
      response: {
        messages: [
          {
            content: `internal ${EMPTY_DELIVERY_SENTINEL} trailing`,
            role: "assistant",
          },
        ],
      },
      text: `internal ${EMPTY_DELIVERY_SENTINEL} trailing`,
      toolCalls: [],
      toolResults: [],
    });

    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(createTestConfig("conversation", emit));

    const result = await runStep(createTestSession(), { message: "Hi" });

    expect(result.next).toBeNull();
    expect(result.session.history).toEqual([{ content: "Hi", role: "user" }]);
    expect(vi.mocked(ToolLoopAgent).mock.calls.length).toBe(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({ message: null }),
        type: "message.completed",
      }),
    );
  });

  it("keeps executable tools directly available to the model", async () => {
    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "Hello!", role: "assistant" }] },
      text: "Hello!",
      toolCalls: [],
      toolResults: [],
    });

    const config = createTestConfig("conversation");
    const runStep = createToolLoopHarness(config);
    const session = createTestSession();

    await runStep(session, { message: "Hi" });

    const agentCall = vi.mocked(ToolLoopAgent).mock.calls[0]?.[0];
    expect(agentCall).toBeDefined();
    expect(agentCall!.tools).toHaveProperty("add");
    expect(agentCall!.tools).not.toHaveProperty("Workflow");
  });

  it("uses dynamic model selection for the model call", async () => {
    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "Hello!", role: "assistant" }] },
      text: "Hello!",
      toolCalls: [],
      toolResults: [],
    });

    const resolveModel = vi.fn().mockResolvedValue("fallback-model" as LanguageModel);
    const dispatchDynamicModelEvent: NonNullable<
      ToolLoopHarnessConfig["dispatchDynamicModelEvent"]
    > = vi.fn(async ({ ctx, event, fallback, messages }) => {
      expect(event.type).toBe("step.started");
      expect(messages.at(-1)).toEqual({ content: "Hi", role: "user" });
      expect(fallback).toEqual({ contextWindowTokens: 100_000, id: "fallback-model" });

      ctx.setVirtualContext(LiveStepDynamicModelSelectionKey, {
        model: "selected-model" as LanguageModel,
        reference: {
          contextWindowTokens: 200_000,
          id: "selected-model",
          providerOptions: { gateway: { order: ["openai"] } },
        },
      });
    });
    const config = createTestConfig("conversation", undefined, {
      dispatchDynamicModelEvent,
      resolveModel,
    });
    const runStep = createToolLoopHarness(config);
    const ctx = new ContextContainer();
    const session = createTestSession({
      agent: {
        dynamicModelDefaultReference: { contextWindowTokens: 100_000, id: "fallback-model" },
        modelReference: { contextWindowTokens: 100_000, id: "fallback-model" },
        system: "You are a test assistant.",
        tools: [{ description: "Adds numbers", name: "add", inputSchema: { type: "object" } }],
      },
      compaction: { recentWindowSize: 10, threshold: 90_000 },
    });

    const result = await contextStorage.run(ctx, () => runStep(session, { message: "Hi" }));

    const agentCall = vi.mocked(ToolLoopAgent).mock.calls[0]?.[0];
    expect(agentCall).toBeDefined();
    expect(agentCall!.model).toBe("selected-model");
    expect(dispatchDynamicModelEvent).toHaveBeenCalledTimes(1);
    expect(resolveModel).not.toHaveBeenCalled();
    expect(result.session.agent.modelReference).toEqual({
      contextWindowTokens: 200_000,
      id: "selected-model",
      providerOptions: { gateway: { order: ["openai"] } },
    });
    expect(result.session.compaction.threshold).toBe(180_000);
  });

  it("uses session-scoped dynamic model selection for the model call", async () => {
    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "Hello!", role: "assistant" }] },
      text: "Hello!",
      toolCalls: [],
      toolResults: [],
    });

    const resolveModel = vi.fn(async (reference) => {
      expect(reference).toEqual({
        contextWindowTokens: 200_000,
        id: "selected-model",
        providerOptions: { gateway: { order: ["openai"] } },
      });
      return "selected-model" as LanguageModel;
    });
    const config = createTestConfig("conversation", undefined, {
      resolveModel,
    });
    const runStep = createToolLoopHarness(config);
    const ctx = new ContextContainer();
    ctx.set(SessionDynamicModelReferenceKey, {
      contextWindowTokens: 200_000,
      id: "selected-model",
      providerOptions: { gateway: { order: ["openai"] } },
    });
    const session = createTestSession({
      agent: {
        dynamicModelDefaultReference: { contextWindowTokens: 100_000, id: "fallback-model" },
        modelReference: { contextWindowTokens: 100_000, id: "fallback-model" },
        system: "You are a test assistant.",
        tools: [{ description: "Adds numbers", name: "add", inputSchema: { type: "object" } }],
      },
      compaction: { recentWindowSize: 10, threshold: 90_000 },
    });

    const result = await contextStorage.run(ctx, () => runStep(session, { message: "Hi" }));

    const agentCall = vi.mocked(ToolLoopAgent).mock.calls[0]?.[0];
    expect(agentCall).toBeDefined();
    expect(agentCall!.model).toBe("selected-model");
    expect(result.session.agent.modelReference).toEqual({
      contextWindowTokens: 200_000,
      id: "selected-model",
      providerOptions: { gateway: { order: ["openai"] } },
    });
    expect(result.session.compaction.threshold).toBe(180_000);
  });

  it("keeps the compaction threshold stable across steps with the same dynamic selection", async () => {
    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "Hello!", role: "assistant" }] },
      text: "Hello!",
      toolCalls: [],
      toolResults: [],
    });

    const config = createTestConfig("conversation", undefined, {
      resolveModel: vi.fn().mockResolvedValue("selected-model" as LanguageModel),
    });
    const runStep = createToolLoopHarness(config);
    const ctx = new ContextContainer();
    ctx.set(SessionDynamicModelReferenceKey, {
      contextWindowTokens: 200_000,
      id: "selected-model",
    });
    const session = createTestSession({
      agent: {
        dynamicModelDefaultReference: { contextWindowTokens: 100_000, id: "fallback-model" },
        modelReference: { contextWindowTokens: 100_000, id: "fallback-model" },
        system: "You are a test assistant.",
        tools: [{ description: "Adds numbers", name: "add", inputSchema: { type: "object" } }],
      },
      compaction: { recentWindowSize: 10, threshold: 90_000 },
    });

    const first = await contextStorage.run(ctx, () => runStep(session, { message: "Hi" }));
    expect(first.session.compaction.threshold).toBe(180_000);

    // Regression: the threshold used to compound (360k) on every extra step.
    const second = await contextStorage.run(ctx, () =>
      runStep(first.session, { message: "Again" }),
    );
    expect(second.session.compaction.threshold).toBe(180_000);

    ctx.set(SessionDynamicModelReferenceKey, null);
    const third = await contextStorage.run(ctx, () => runStep(second.session, { message: "Back" }));
    expect(third.session.agent.modelReference).toEqual({
      contextWindowTokens: 100_000,
      id: "fallback-model",
    });
    expect(third.session.compaction.threshold).toBe(90_000);
  });

  it("hides subagent tools from the model after the subagent depth limit", async () => {
    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "Hello!", role: "assistant" }] },
      text: "Hello!",
      toolCalls: [],
      toolResults: [],
    });

    const config = createTestConfig("conversation", undefined, {
      tools: createDelegationToolMap(),
    });
    const runStep = createToolLoopHarness(config);

    await runStep(createTestSession({ subagentDepth: DEFAULT_SUBAGENT_MAX_DEPTH }), {
      message: "Hi",
    });

    const agentCall = vi.mocked(ToolLoopAgent).mock.calls[0]?.[0];
    expect(agentCall).toBeDefined();
    expect(agentCall!.tools).toHaveProperty("add");
    expect(agentCall!.tools).not.toHaveProperty("delegate");
  });

  it("publishes subagent calls from the current run immediately before the depth limit", async () => {
    setupMockAgent({
      finishReason: "tool-calls",
      response: {
        messages: [
          {
            content: [
              {
                input: { message: "delegate at depth 2" },
                toolCallId: "call-1",
                toolName: "delegate",
                type: "tool-call",
              },
            ],
            role: "assistant",
          },
        ],
      },
      text: "",
      toolCalls: [
        {
          input: { message: "delegate at depth 2" },
          toolCallId: "call-1",
          toolName: "delegate",
          type: "tool-call",
        },
      ],
      toolResults: [],
    });

    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(
      createTestConfig("conversation", emit, { tools: createDelegationToolMap() }),
    );

    const result = await runStep(
      createTestSession({ subagentDepth: DEFAULT_SUBAGENT_MAX_DEPTH - 1 }),
      {
        message: "Hi",
      },
    );

    expect(events.find((event) => event.type === "actions.requested")?.data.actions).toEqual([
      {
        callId: "call-1",
        description: "Delegate to a subagent.",
        input: { message: "delegate at depth 2" },
        kind: "subagent-call",
        name: "delegate",
        nodeId: "workers",
        subagentName: "worker",
      },
    ]);
    expect(getPendingRuntimeActionBatch(result.session.state)?.actions).toEqual([
      {
        callId: "call-1",
        description: "Delegate to a subagent.",
        input: { message: "delegate at depth 2" },
        kind: "subagent-call",
        name: "delegate",
        nodeId: "workers",
        subagentName: "worker",
      },
    ]);
  });

  it("does not publish subagent calls from the current run at the depth limit", async () => {
    setupMockAgent({
      finishReason: "tool-calls",
      response: {
        messages: [
          {
            content: [
              {
                input: { message: "delegate at depth 3" },
                toolCallId: "call-1",
                toolName: "delegate",
                type: "tool-call",
              },
            ],
            role: "assistant",
          },
        ],
      },
      text: "",
      toolCalls: [
        {
          input: { message: "delegate at depth 3" },
          toolCallId: "call-1",
          toolName: "delegate",
          type: "tool-call",
        },
      ],
      toolResults: [],
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(
      createTestConfig("conversation", emit, { tools: createDelegationToolMap() }),
    );

    const result = await runStep(createTestSession({ subagentDepth: DEFAULT_SUBAGENT_MAX_DEPTH }), {
      message: "Hi",
    });

    expect(events.some((event) => event.type === "actions.requested")).toBe(false);
    expect(getPendingRuntimeActionBatch(result.session.state)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "[eve:harness.tool-loop] runtime action tool call blocked because tool is not advertised",
      expect.objectContaining({
        callId: "call-1",
        sessionId: "test-session",
        toolName: "delegate",
      }),
    );
  });

  it("omits Workflow when subagent host tools are hidden by the depth limit", async () => {
    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "Hello!", role: "assistant" }] },
      text: "Hello!",
      toolCalls: [],
      toolResults: [],
    });

    const config = createTestConfig("conversation", undefined, {
      workflow: true,
      tools: new Map([
        [
          "delegate",
          {
            description: "Delegate to a subagent.",
            inputSchema: jsonSchema({ type: "object" }),
            name: "delegate",
            runtimeAction: {
              kind: "subagent-call",
              nodeId: "workers",
              subagentName: "worker",
            },
          },
        ],
      ]),
    });
    const runStep = createToolLoopHarness(config);

    await runStep(createTestSession({ subagentDepth: DEFAULT_SUBAGENT_MAX_DEPTH }), {
      message: "Hi",
    });

    const agentCall = vi.mocked(ToolLoopAgent).mock.calls[0]?.[0];
    expect(agentCall).toBeDefined();
    expect(agentCall!.tools).not.toHaveProperty("delegate");
    expect(agentCall!.tools).not.toHaveProperty("Workflow");
  });

  it("omits Workflow from runtime subagent sessions", async () => {
    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "Hello!", role: "assistant" }] },
      text: "Hello!",
      toolCalls: [],
      toolResults: [],
    });

    const config = createTestConfig("conversation", undefined, {
      workflow: true,
      tools: createDelegationToolMap(),
    });
    const runStep = createToolLoopHarness(config);

    await runStep(
      createTestSession({
        rootSessionId: "root-session",
        subagentDepth: 1,
      }),
      { message: "Hi" },
    );

    const agentCall = vi.mocked(ToolLoopAgent).mock.calls[0]?.[0];
    expect(agentCall).toBeDefined();
    expect(agentCall!.tools).toHaveProperty("delegate");
    expect(agentCall!.tools).not.toHaveProperty("Workflow");
  });

  it("forwards the agent reasoning effort to the model call", async () => {
    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "Hello!", role: "assistant" }] },
      text: "Hello!",
      toolCalls: [],
      toolResults: [],
    });

    const runStep = createToolLoopHarness(createTestConfig());
    const session = createTestSession({
      agent: {
        modelReference: { id: "test-model" },
        reasoning: "high",
        system: "You are a test assistant.",
        tools: [],
      },
    });

    await runStep(session, { message: "Think carefully" });

    expect(vi.mocked(ToolLoopAgent).mock.calls[0]?.[0]).toMatchObject({ reasoning: "high" });
  });

  it("accumulates provider-reported token usage across the session", async () => {
    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "Hello!", role: "assistant" }] },
      text: "Hello!",
      toolCalls: [],
      toolResults: [],
      usage: {
        inputTokenDetails: { cacheReadTokens: 2, cacheWriteTokens: 1 },
        inputTokens: 7,
        outputTokens: 3,
      },
    });

    const runStep = createToolLoopHarness(createTestConfig());
    const result = await runStep(createTestSession(), { message: "Hi" });

    expect(getSessionTokenUsage(result.session)).toEqual({
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      costUsd: 0,
      inputTokens: 7,
      outputTokens: 3,
      sawCost: false,
    });
  });

  it.each([
    {
      details: {
        inputTokens: 12,
        kind: "input",
        limit: 12,
        outputTokens: 3,
        usedTokens: 12,
      },
      message: "The session reached its configured input token limit.",
      limits: {
        maxInputTokensPerSession: 12,
      },
      usage: {
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        costUsd: 0,
        inputTokens: 12,
        outputTokens: 3,
        sawCost: false,
      },
      tokenKind: "input",
    },
    {
      details: {
        inputTokens: 7,
        kind: "output",
        limit: 3,
        outputTokens: 3,
        usedTokens: 3,
      },
      message: "The session reached its configured output token limit.",
      limits: {
        maxOutputTokensPerSession: 3,
      },
      usage: {
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        costUsd: 0,
        inputTokens: 7,
        outputTokens: 3,
        sawCost: false,
      },
      tokenKind: "output",
    },
  ])(
    "fails fast after the $tokenKind token limit when the session cannot request input",
    async (testCase) => {
      const { emit, events } = createEventCollector();
      const runStep = createToolLoopHarness(createTestConfig("task", emit));
      const session = setTurnUsageState(createTestSession({ limits: testCase.limits }), {
        turnId: "turn_previous",
        ...testCase.usage,
        session: testCase.usage,
      });

      const result = await runStep(session, { message: "Hi again" });

      expect(vi.mocked(ToolLoopAgent)).not.toHaveBeenCalled();
      expect(result.next).toEqual({ done: true, isError: true, output: testCase.message });
      expect(events.map((event) => event.type)).toEqual([
        "session.started",
        "turn.started",
        "message.received",
        "step.started",
        "step.failed",
        "turn.failed",
        "session.failed",
      ]);
      expect(events.find((event) => event.type === "step.failed")?.data).toMatchObject({
        code: "SESSION_TOKEN_LIMIT_REACHED",
        details: testCase.details,
        message: testCase.message,
      });
    },
  );

  // Session state with 12 input tokens already spent against a 12-token
  // budget: the next model call is over the limit. The matching continuation
  // request id is `test-session:limit:input:12` (absolute total = 12).
  function createLimitReachedSession(): HarnessSession {
    const usage = {
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      inputTokens: 12,
      outputTokens: 3,
      sawCost: false,
    };
    return setTurnUsageState(createTestSession({ limits: { maxInputTokensPerSession: 12 } }), {
      turnId: "turn_previous",
      ...usage,
      session: usage,
    });
  }

  const LIMIT_REQUEST_ID = "test-session:limit:input:12";

  it("parks on a deterministic continuation prompt when the session reaches its token limit", async () => {
    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(createTestConfig("conversation", emit));

    const result = await runStep(createLimitReachedSession(), { message: "Hi again" });

    expect(vi.mocked(ToolLoopAgent)).not.toHaveBeenCalled();
    expect(result.next).toBeNull();
    expect(events.map((event) => event.type)).toEqual([
      "session.started",
      "turn.started",
      "message.received",
      "step.started",
      "input.requested",
      "turn.completed",
      "session.waiting",
    ]);
    const requested = events.find((event) => event.type === "input.requested");
    expect(requested?.data).toMatchObject({
      requests: [
        {
          action: {
            callId: LIMIT_REQUEST_ID,
            input: { kind: "input", limit: 12, usedTokens: 12 },
            kind: "tool-call",
            toolName: "session_limit_continuation",
          },
          allowFreeform: false,
          display: "confirmation",
          options: [
            { id: "continue", label: "Continue", style: "primary" },
            { id: "stop", label: "Stop", style: "danger" },
          ],
          requestId: LIMIT_REQUEST_ID,
        },
      ],
    });
  });

  it("grants a fresh token budget when the user continues past the limit prompt", async () => {
    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "Hello!", role: "assistant" }] },
      text: "Hello!",
      toolCalls: [],
      toolResults: [],
      usage: { inputTokens: 7, outputTokens: 3 },
    });
    const { emit } = createEventCollector();
    const runStep = createToolLoopHarness(createTestConfig("conversation", emit));

    const parked = await runStep(createLimitReachedSession(), { message: "Hi again" });
    expect(vi.mocked(ToolLoopAgent)).not.toHaveBeenCalled();

    const resumed = await runStep(parked.session, {
      inputResponses: [{ optionId: "continue", requestId: LIMIT_REQUEST_ID }],
    });

    expect(vi.mocked(ToolLoopAgent)).toHaveBeenCalledTimes(1);
    expect(resumed.next).toBeNull();
    expect(getSessionTokenLimitViolation(resumed.session)).toBeNull();
    // The parked user message survives into model history for the resumed call.
    expect(resumed.session.history).toContainEqual({ content: "Hi again", role: "user" });
  });

  it("grants the budget when the user types the continue option as plain text", async () => {
    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "Hello!", role: "assistant" }] },
      text: "Hello!",
      toolCalls: [],
      toolResults: [],
      usage: { inputTokens: 7, outputTokens: 3 },
    });
    const { emit } = createEventCollector();
    const runStep = createToolLoopHarness(createTestConfig("conversation", emit));

    const parked = await runStep(createLimitReachedSession(), { message: "Hi again" });

    // Surfaces without buttons deliver the answer as a plain message;
    // resolveTextToResponses maps it onto the pending option.
    const resumed = await runStep(parked.session, { message: "continue" });

    expect(vi.mocked(ToolLoopAgent)).toHaveBeenCalledTimes(1);
    expect(resumed.next).toBeNull();
    expect(getSessionTokenLimitViolation(resumed.session)).toBeNull();
  });

  it("ends the session gracefully when the user declines the limit continuation prompt", async () => {
    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(createTestConfig("conversation", emit));

    const parked = await runStep(createLimitReachedSession(), { message: "Hi again" });
    const declined = await runStep(parked.session, {
      inputResponses: [{ optionId: "stop", requestId: LIMIT_REQUEST_ID }],
    });

    expect(vi.mocked(ToolLoopAgent)).not.toHaveBeenCalled();
    expect(declined.next).toEqual({ done: true, output: "" });
    // A decline is a user decision, not an error: no failure events, no extra
    // chat copy — the resolved prompt is the acknowledgment.
    expect(events.some((event) => event.type.endsWith(".failed"))).toBe(false);
    expect(events.at(-2)?.type).toBe("turn.completed");
    expect(events.at(-1)?.type).toBe("session.completed");
  });

  it("fails the task when a proxied user declines the limit continuation prompt", async () => {
    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(
      createTestConfig("task", emit, { capabilities: { requestInput: true } }),
    );

    const parked = await runStep(createLimitReachedSession(), { message: "Hi again" });
    expect(parked.next).toBeNull();

    const declined = await runStep(parked.session, {
      inputResponses: [{ optionId: "stop", requestId: LIMIT_REQUEST_ID }],
    });

    expect(vi.mocked(ToolLoopAgent)).not.toHaveBeenCalled();
    expect(declined.next).toEqual({
      done: true,
      isError: true,
      output: "The session reached its configured input token limit.",
    });
    expect(events.find((event) => event.type === "step.failed")?.data).toMatchObject({
      code: "SESSION_TOKEN_LIMIT_REACHED",
      details: { kind: "input", limit: 12, usedTokens: 12 },
    });
  });

  it("re-raises the limit prompt when the user replies without answering it", async () => {
    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(createTestConfig("conversation", emit));

    const parked = await runStep(createLimitReachedSession(), { message: "Hi again" });
    const reparked = await runStep(parked.session, { message: "also do this other thing" });

    expect(vi.mocked(ToolLoopAgent)).not.toHaveBeenCalled();
    expect(reparked.next).toBeNull();
    expect(events.filter((event) => event.type === "input.requested")).toHaveLength(2);
  });

  it("preserves approval gates on step-scoped dynamic tools", async () => {
    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "Hello!", role: "assistant" }] },
      text: "Hello!",
      toolCalls: [],
      toolResults: [],
    });

    const approval = vi.fn(() => "user-approval" as const);
    const ctx = new ContextContainer();
    ctx.set(SessionKey, {
      auth: {
        current: {
          attributes: { tenant: "tenant_test" },
          authenticator: "jwt",
          principalId: "caller_test",
          principalType: "user",
        },
        initiator: null,
      },
      sessionId: "test-session",
      turn: { id: "turn-test", sequence: 0 },
    });
    ctx.setVirtualContext(LiveStepToolsKey, [
      {
        description: "Get TfL line status.",
        execute: vi.fn().mockResolvedValue({ ok: true }),
        inputSchema: jsonSchema({ type: "object" }),
        name: "tfl__getLineStatus",
        approval,
      },
    ]);

    const config = createTestConfig("conversation");
    const runStep = createToolLoopHarness(config);
    await contextStorage.run(ctx, () => runStep(createTestSession(), { message: "Hi" }));

    const agentCall = vi.mocked(ToolLoopAgent).mock.calls[0]?.[0] as
      | {
          toolApproval?: (options: {
            toolCall: { input: unknown; toolCallId: string; toolName: string };
          }) => Promise<unknown>;
        }
      | undefined;
    expect(agentCall).toBeDefined();
    await expect(
      contextStorage.run(ctx, () =>
        agentCall!.toolApproval?.({
          toolCall: {
            input: { line: "victoria" },
            toolCallId: "call_1",
            toolName: "tfl__getLineStatus",
          },
        }),
      ),
    ).resolves.toBe("user-approval");
    expect(approval).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        approvedTools: new Set(),
        session: expect.objectContaining({
          auth: expect.objectContaining({
            current: expect.objectContaining({ principalId: "caller_test" }),
          }),
          id: "test-session",
          turn: { id: "turn-test", sequence: 0 },
        }),
        toolInput: { line: "victoria" },
        toolName: "tfl__getLineStatus",
      }),
    );
  });

  it("preserves a user-authored web_search tool instead of replacing it with the provider tool", async () => {
    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "result", role: "assistant" }] },
      text: "result",
      toolCalls: [],
      toolResults: [],
    });

    const userExecutor = vi.fn().mockResolvedValue("custom search result");
    const session = createTestSession({
      agent: {
        modelReference: { id: "openai/gpt-5.4" },
        system: "You are a test assistant.",
        tools: [
          { description: "Adds numbers", name: "add", inputSchema: { type: "object" } },
          { description: "Custom search.", name: "web_search", inputSchema: { type: "object" } },
        ],
      },
    });
    const config: ToolLoopHarnessConfig = {
      mode: "conversation",
      resolveModel: vi.fn().mockResolvedValue({} as LanguageModel),
      tools: new Map([
        [
          "add",
          {
            description: "Adds numbers",
            execute: vi.fn().mockResolvedValue("42"),
            inputSchema: jsonSchema({ type: "object" }),
            name: "add",
          },
        ],
        [
          "web_search",
          {
            description: "Custom search.",
            execute: userExecutor,
            inputSchema: jsonSchema({ type: "object" }),
            name: "web_search",
          },
        ],
      ]),
    };

    const runStep = createToolLoopHarness(config);
    await runStep(session, { message: "search" });

    // The ToolLoopAgent should expose the user's web_search override directly,
    // not replace it with a provider-managed tool.
    const agentCall = vi.mocked(ToolLoopAgent).mock.calls[0]?.[0];
    expect(agentCall).toBeDefined();
    expect(agentCall!.tools).toHaveProperty("web_search");
    expect(agentCall!.tools).not.toHaveProperty("Workflow");
  });

  it("returns done when task mode finishes with stop", async () => {
    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "Hello!", role: "assistant" }] },
      text: "Hello!",
      toolCalls: [],
      toolResults: [],
    });

    const config = createTestConfig("task");
    const runStep = createToolLoopHarness(config);
    const session = createTestSession();

    const result = await runStep(session, { message: "Hi" });

    expect(result.next).toEqual({ done: true, output: "Hello!" });
  });

  it("returns an empty successful result when a task chooses not to deliver", async () => {
    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: EMPTY_DELIVERY_SENTINEL, role: "assistant" }] },
      text: EMPTY_DELIVERY_SENTINEL,
      toolCalls: [],
      toolResults: [],
    });

    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(createTestConfig("task", emit));

    const result = await runStep(createTestSession(), { message: "Check for alerts." });

    expect(result.next).toEqual({ done: true, output: "" });
    expect(vi.mocked(ToolLoopAgent)).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({ message: null }),
        type: "message.completed",
      }),
    );
  });

  it("emits result.completed when a run output schema is requested", async () => {
    const schema = {
      properties: { title: { type: "string" } },
      required: ["title"],
      type: "object",
    } as const;
    setupMockAgent(finalOutputResult("Here is the summary.", { title: "Done" }));

    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(createTestConfig("conversation", emit));
    const session = createTestSession({ outputSchema: schema });

    const result = await runStep(session, { message: "Hi" });

    expect(result.next).toBeNull();
    expect(getCompatibilityEventTypes(events)).toEqual([
      "session.started",
      "turn.started",
      "message.received",
      "step.started",
      "message.completed",
      "step.completed",
      "result.completed",
      "turn.completed",
      "session.waiting",
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({ result: { title: "Done" } }),
        type: "result.completed",
      }),
    );
    expect(result.session.history).toEqual([
      { content: "Hi", role: "user" },
      { content: '{"title":"Done"}', role: "assistant" },
    ]);
    expect(result.session.outputSchema).toBeUndefined();
    expect(vi.mocked(ToolLoopAgent).mock.calls[0]?.[0]).toMatchObject({
      tools: expect.objectContaining({ final_output: expect.anything() }),
    });
  });

  it("produces structured task output when a schema is in effect", async () => {
    const schema = {
      properties: { summary: { type: "string" } },
      required: ["summary"],
      type: "object",
    } as const;
    setupMockAgent(finalOutputResult("Done.", { summary: "Done" }));

    const config = createTestConfig("task");
    const runStep = createToolLoopHarness(config);
    const session = createTestSession({ outputSchema: schema });

    const result = await runStep(session, { message: "Hi" });

    expect(result.next).toEqual({ done: true, output: { summary: "Done" } });
  });

  it("fails a task turn as an error when structured output is not produced", async () => {
    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "Plain prose, no tool call.", role: "assistant" }] },
      text: "Plain prose, no tool call.",
      toolCalls: [],
      toolResults: [],
    });

    const config = createTestConfig("task");
    const runStep = createToolLoopHarness(config);
    const session = createTestSession({ outputSchema: { type: "object" } });

    const result = await runStep(session, { message: "Hi" });

    expect(result.next).toMatchObject({ done: true, isError: true });
  });

  it("does not offer final_output when no schema is in effect", async () => {
    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "Hello!", role: "assistant" }] },
      text: "Hello!",
      toolCalls: [],
      toolResults: [],
    });

    const config = createTestConfig("conversation");
    const runStep = createToolLoopHarness(config);
    const session = createTestSession();

    await runStep(session, { message: "Hi" });

    expect(vi.mocked(ToolLoopAgent).mock.calls).toHaveLength(1);
    expect(vi.mocked(ToolLoopAgent).mock.calls[0]?.[0]).not.toMatchObject({
      tools: expect.objectContaining({ final_output: expect.anything() }),
    });
  });

  it("treats a final_output call as terminal even alongside an executing tool", async () => {
    const schema = {
      properties: { title: { type: "string" } },
      required: ["title"],
      type: "object",
    } as const;
    // The model emits final_output in parallel with a regular executing tool:
    // the executing tool produces a tool message (last role "tool"), which would
    // otherwise continue the loop and strand the no-execute final_output call.
    setupMockAgent({
      finishReason: "tool-calls",
      response: {
        messages: [
          {
            content: [
              { type: "tool-call", toolCallId: "add-1", toolName: "add", input: {} },
              {
                type: "tool-call",
                toolCallId: "final-output-1",
                toolName: "final_output",
                input: { title: "Done" },
              },
            ],
            role: "assistant",
          },
          {
            content: [{ type: "tool-result", toolCallId: "add-1", toolName: "add", output: "42" }],
            role: "tool",
          },
        ],
      },
      text: "",
      toolCalls: [
        { input: {}, toolCallId: "add-1", toolName: "add" },
        { input: { title: "Done" }, toolCallId: "final-output-1", toolName: "final_output" },
      ],
      toolResults: [{ toolCallId: "add-1", toolName: "add", output: "42" }],
    });

    const config = createTestConfig("task");
    const runStep = createToolLoopHarness(config);
    const session = createTestSession({ outputSchema: schema });

    const result = await runStep(session, { message: "Hi" });

    expect(result.next).toEqual({ done: true, output: { title: "Done" } });
    // The un-executed final_output call is never persisted, so no dangling
    // tool_use survives into history.
    expect(result.session.history).toEqual([
      { content: "Hi", role: "user" },
      { content: '{"title":"Done"}', role: "assistant" },
    ]);
    expect(result.session.outputSchema).toBeUndefined();
  });

  it("parks a conversation when requested structured output is not fulfilled", async () => {
    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "Hello!", role: "assistant" }] },
      text: "Hello!",
      toolCalls: [],
      toolResults: [],
    });

    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(createTestConfig("conversation", emit));
    const session = createTestSession({ outputSchema: { type: "object" } });

    const result = await runStep(session, { message: "Hi" });

    expect(result.next).toBeNull();
    expect(getCompatibilityEventTypes(events)).toEqual([
      "session.started",
      "turn.started",
      "message.received",
      "step.started",
      "message.completed",
      "step.completed",
      "step.failed",
      "turn.failed",
      "session.waiting",
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({ code: "OUTPUT_SCHEMA_NOT_FULFILLED" }),
        type: "step.failed",
      }),
    );
  });

  it("returns only the final assistant reply when a completed task step includes tool work", async () => {
    setupMockAgent({
      finishReason: "stop",
      response: {
        messages: [
          {
            content: [
              { text: "I'll look that up.", type: "text" },
              {
                input: { query: "weather in ny" },
                toolCallId: "call-1",
                toolName: "web_search",
                type: "tool-call",
              },
            ],
            role: "assistant",
          },
          {
            content: [
              {
                output: { temperature: "41 F" },
                toolCallId: "call-1",
                toolName: "web_search",
                type: "tool-result",
              },
            ],
            role: "tool",
          },
          { content: "It is 41 F in New York right now.", role: "assistant" },
        ],
      },
      text: "It is 41 F in New York right now.",
      toolCalls: [
        {
          input: { query: "weather in ny" },
          toolCallId: "call-1",
          toolName: "web_search",
          type: "tool-call",
        },
      ],
      toolResults: [
        {
          input: { query: "weather in ny" },
          output: { temperature: "41 F" },
          toolCallId: "call-1",
          toolName: "web_search",
          type: "tool-result",
        },
      ],
    });

    const config = createTestConfig("task", undefined, {
      tools: new Map(),
    });
    const runStep = createToolLoopHarness(config);
    const session = createTestSession({
      agent: {
        modelReference: { id: "openai/gpt-5.4" },
        system: "You are a test assistant.",
        tools: [
          { description: "Search the web", name: "web_search", inputSchema: { type: "object" } },
        ],
      },
    });

    const result = await runStep(session, { message: "What's the weather in NY?" });

    expect(result.next).toEqual({ done: true, output: "It is 41 F in New York right now." });
  });

  it("returns next: runStep (continue) when model makes tool calls", async () => {
    setupMockAgent({
      finishReason: "tool-calls",
      response: {
        messages: [
          {
            content: [
              { text: "Let me add those.", type: "text" },
              { input: { a: 1, b: 2 }, toolCallId: "call-1", toolName: "add", type: "tool-call" },
            ],
            role: "assistant",
          },
          {
            content: [{ output: "42", toolCallId: "call-1", toolName: "add", type: "tool-result" }],
            role: "tool",
          },
        ],
      },
      text: "",
      toolCalls: [
        { input: { a: 1, b: 2 }, toolCallId: "call-1", toolName: "add", type: "tool-call" },
      ],
      toolResults: [
        {
          input: { a: 1, b: 2 },
          output: "42",
          toolCallId: "call-1",
          toolName: "add",
          type: "tool-result",
        },
      ],
    });

    const config = createTestConfig("conversation");
    const runStep = createToolLoopHarness(config);
    const session = createTestSession();

    const result = await runStep(session, { message: "Add 1 and 2" });

    expect(typeof result.next).toBe("function");
    expect(result.session.history.length).toBeGreaterThan(0);
    expect(result.session.history[result.session.history.length - 1]?.role).toBe("tool");
  });

  it("parks when a completed step also includes tool calls and tool results", async () => {
    setupMockAgent({
      finishReason: "stop",
      response: {
        messages: [
          {
            content: [
              {
                input: { query: "weather in ny" },
                toolCallId: "call-1",
                toolName: "web_search",
                type: "tool-call",
              },
            ],
            role: "assistant",
          },
          {
            content: [
              {
                output: { temperature: "41 F" },
                toolCallId: "call-1",
                toolName: "web_search",
                type: "tool-result",
              },
            ],
            role: "tool",
          },
          { content: "It is 41 F in New York right now.", role: "assistant" },
        ],
      },
      text: "It is 41 F in New York right now.",
      toolCalls: [
        {
          input: { query: "weather in ny" },
          toolCallId: "call-1",
          toolName: "web_search",
          type: "tool-call",
        },
      ],
      toolResults: [
        {
          input: { query: "weather in ny" },
          output: { temperature: "41 F" },
          toolCallId: "call-1",
          toolName: "web_search",
          type: "tool-result",
        },
      ],
    });

    const config = createTestConfig("conversation", undefined, {
      tools: new Map([
        [
          "web_search",
          {
            description: "Search the web",
            inputSchema: jsonSchema({ type: "object" }),
            name: "web_search",
          },
        ],
      ]),
    });
    const runStep = createToolLoopHarness(config);
    const session = createTestSession({
      agent: {
        modelReference: { id: "openai/gpt-5.4" },
        system: "You are a test assistant.",
        tools: [
          { description: "Search the web", name: "web_search", inputSchema: { type: "object" } },
        ],
      },
    });

    const result = await runStep(session, { message: "What's the weather in NY?" });

    expect(result.next).toBeNull();
    expect(result.session.history).toEqual([
      { content: "What's the weather in NY?", role: "user" },
      {
        content: [
          {
            input: { query: "weather in ny" },
            toolCallId: "call-1",
            toolName: "web_search",
            type: "tool-call",
          },
        ],
        role: "assistant",
      },
      {
        content: [
          {
            output: { temperature: "41 F" },
            toolCallId: "call-1",
            toolName: "web_search",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
      { content: "It is 41 F in New York right now.", role: "assistant" },
    ]);
  });

  it("continues when a step ends on a tool result even if the SDK reports stop", async () => {
    setupMockAgent({
      finishReason: "stop",
      response: {
        messages: [
          {
            content: [
              {
                input: { query: "weather in ny" },
                toolCallId: "call-1",
                toolName: "web_search",
                type: "tool-call",
              },
            ],
            role: "assistant",
          },
          {
            content: [
              {
                output: { temperature: "41 F" },
                toolCallId: "call-1",
                toolName: "web_search",
                type: "tool-result",
              },
            ],
            role: "tool",
          },
        ],
      },
      text: "",
      toolCalls: [
        {
          input: { query: "weather in ny" },
          toolCallId: "call-1",
          toolName: "web_search",
          type: "tool-call",
        },
      ],
      toolResults: [
        {
          input: { query: "weather in ny" },
          output: { temperature: "41 F" },
          toolCallId: "call-1",
          toolName: "web_search",
          type: "tool-result",
        },
      ],
    });

    const config = createTestConfig("conversation", undefined, {
      tools: new Map([
        [
          "web_search",
          {
            description: "Search the web",
            inputSchema: jsonSchema({ type: "object" }),
            name: "web_search",
          },
        ],
      ]),
    });
    const runStep = createToolLoopHarness(config);
    const session = createTestSession({
      agent: {
        modelReference: { id: "openai/gpt-5.4" },
        system: "You are a test assistant.",
        tools: [
          { description: "Search the web", name: "web_search", inputSchema: { type: "object" } },
        ],
      },
    });

    const result = await runStep(session, { message: "What's the weather in NY?" });

    expect(typeof result.next).toBe("function");
    expect(result.session.history).toEqual([
      { content: "What's the weather in NY?", role: "user" },
      {
        content: [
          {
            input: { query: "weather in ny" },
            toolCallId: "call-1",
            toolName: "web_search",
            type: "tool-call",
          },
        ],
        role: "assistant",
      },
      {
        content: [
          {
            output: { temperature: "41 F" },
            toolCallId: "call-1",
            toolName: "web_search",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ]);
  });

  it("normalizes persisted tool-call messages before storing them on the session", async () => {
    setupMockAgent({
      finishReason: "tool-calls",
      response: {
        messages: [
          {
            content: [
              {
                input: { a: 1, b: 2 },
                providerOptions: undefined,
                toolCallId: "call-1",
                toolName: "add",
                type: "tool-call",
              },
            ],
            role: "assistant",
          },
          {
            content: [{ output: "42", toolCallId: "call-1", toolName: "add", type: "tool-result" }],
            role: "tool",
          },
        ],
      },
      text: "",
      toolCalls: [
        { input: { a: 1, b: 2 }, toolCallId: "call-1", toolName: "add", type: "tool-call" },
      ],
      toolResults: [
        {
          input: { a: 1, b: 2 },
          output: "42",
          toolCallId: "call-1",
          toolName: "add",
          type: "tool-result",
        },
      ],
    });

    const config = createTestConfig("conversation");
    const runStep = createToolLoopHarness(config);
    const session = createTestSession();

    const result = await runStep(session, { message: "Add 1 and 2" });
    const assistantMessage = result.session.history.find(
      (message) => message.role === "assistant" && Array.isArray(message.content),
    );
    const toolCallPart =
      assistantMessage?.role === "assistant" && Array.isArray(assistantMessage.content)
        ? assistantMessage.content[0]
        : undefined;

    expect(toolCallPart).toEqual({
      input: { a: 1, b: 2 },
      toolCallId: "call-1",
      toolName: "add",
      type: "tool-call",
    });
  });

  it("parks without input (tool continuation) on stop", async () => {
    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "The result is 42.", role: "assistant" }] },
      text: "The result is 42.",
      toolCalls: [],
      toolResults: [],
    });

    const config = createTestConfig("conversation");
    const runStep = createToolLoopHarness(config);
    const session = createTestSession({
      history: [{ content: "prior message", role: "user" }],
    });

    const result = await runStep(session);

    expect(result.next).toBeNull();
    expect(result.session.history).toEqual([
      { content: "prior message", role: "user" },
      { content: "The result is 42.", role: "assistant" },
    ]);
  });

  it("returns park (next: null) when model finishes with non-stop reason", async () => {
    setupMockAgent({
      finishReason: "length",
      response: { messages: [{ content: "I was cut off mid-", role: "assistant" }] },
      text: "I was cut off mid-",
      toolCalls: [],
      toolResults: [],
    });

    const config = createTestConfig("conversation");
    const runStep = createToolLoopHarness(config);
    const session = createTestSession();

    const result = await runStep(session, { message: "Tell me a story" });

    expect(result.next).toBeNull();
  });

  it("emits session, turn, and step lifecycle events on first user message", async () => {
    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "Hello!", role: "assistant" }] },
      text: "Hello!",
      toolCalls: [],
      toolResults: [],
    });

    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(createTestConfig("conversation", emit));

    await runStep(createTestSession(), { message: "Hi" });

    expect(getCompatibilityEventTypes(events)).toEqual([
      "session.started",
      "turn.started",
      "message.received",
      "step.started",
      "message.completed",
      "step.completed",
      "turn.completed",
      "session.waiting",
    ]);
  });

  it("does not emit turn preamble on tool continuation (no input)", async () => {
    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "42", role: "assistant" }] },
      text: "42",
      toolCalls: [],
      toolResults: [],
    });

    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(createTestConfig("conversation", emit));

    await runStep(createTestSession({ history: [{ content: "prior", role: "user" }] }));

    expect(getCompatibilityEventTypes(events)).toEqual([
      "step.started",
      "message.completed",
      "step.completed",
      "turn.completed",
      "session.waiting",
    ]);
  });

  it("preserves turn ids across recreated harness instances during tool continuation", async () => {
    setupMockAgent({
      finishReason: "tool-calls",
      response: {
        messages: [
          {
            content: [
              { text: "Let me calculate that first.", type: "text" },
              { input: { a: 1, b: 2 }, toolCallId: "call-1", toolName: "add", type: "tool-call" },
            ],
            role: "assistant",
          },
          {
            content: [{ output: "42", toolCallId: "call-1", toolName: "add", type: "tool-result" }],
            role: "tool",
          },
        ],
      },
      text: "",
      toolCalls: [
        { input: { a: 1, b: 2 }, toolCallId: "call-1", toolName: "add", type: "tool-call" },
      ],
      toolResults: [
        {
          input: { a: 1, b: 2 },
          output: "42",
          toolCallId: "call-1",
          toolName: "add",
          type: "tool-result",
        },
      ],
    });

    const { emit, events } = createEventCollector();
    const config = createTestConfig("conversation", emit, {
      tools: new Map([
        [
          "add",
          {
            description: "Adds numbers",
            execute: vi.fn().mockResolvedValue("42"),
            inputSchema: jsonSchema({ type: "object" }),
            name: "add",
          },
        ],
        [
          "bash",
          {
            description: "Run shell commands",
            execute: vi.fn().mockResolvedValue("ok"),
            inputSchema: jsonSchema({ type: "object" }),
            name: "bash",
          },
        ],
      ]),
    });
    const session = createTestSession({
      agent: {
        modelReference: { id: "test-model" },
        system: "You are a test assistant.",
        tools: [
          { description: "Adds numbers", name: "add", inputSchema: { type: "object" } },
          { description: "Run shell commands", name: "bash", inputSchema: { type: "object" } },
        ],
      },
    });

    const firstResult = await createToolLoopHarness(config)(session, {
      message: "Add 1 and 2, then maybe use bash.",
    });
    expect(typeof firstResult.next).toBe("function");

    setupMockAgent({
      content: [
        {
          approvalId: "approval-1",
          toolCall: {
            input: { command: "echo blocked" },
            toolCallId: "call-2",
            toolName: "bash",
          },
          type: "tool-approval-request",
        },
      ],
      finishReason: "tool-calls",
      response: {
        messages: [
          {
            content: [
              { text: "Need approval before I can continue.", type: "text" },
              {
                input: { command: "echo blocked" },
                toolCallId: "call-2",
                toolName: "bash",
                type: "tool-call",
              },
              {
                approvalId: "approval-1",
                toolCallId: "call-2",
                type: "tool-approval-request",
              },
            ],
            role: "assistant",
          },
        ],
      },
      text: "",
      toolCalls: [
        {
          input: { command: "echo blocked" },
          toolCallId: "call-2",
          toolName: "bash",
          type: "tool-call",
        },
      ],
      toolResults: [],
    });

    const secondResult = await createToolLoopHarness(config)(firstResult.session);

    expect(secondResult.next).toBeNull();
    expect(events.filter((event) => event.type === "input.requested").at(-1)).toEqual({
      data: {
        requests: [
          {
            action: {
              callId: "call-2",
              input: { command: "echo blocked" },
              kind: "tool-call",
              toolName: "bash",
            },
            allowFreeform: false,
            display: "confirmation",
            options: [
              { id: "approve", label: "Yes" },
              { id: "deny", label: "No" },
            ],
            prompt: "Approve tool call: bash",
            requestId: "approval-1",
          },
        ],
        sequence: 0,
        stepIndex: 1,
        turnId: "turn_0",
      },
      type: "input.requested",
    });
    expect(events.filter((event) => event.type === "turn.completed").at(-1)).toEqual({
      data: {
        sequence: 0,
        turnId: "turn_0",
      },
      type: "turn.completed",
    });
  });

  it("emits session.completed instead of session.waiting in task mode", async () => {
    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "done", role: "assistant" }] },
      text: "done",
      toolCalls: [],
      toolResults: [],
    });

    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(createTestConfig("task", emit));

    await runStep(createTestSession(), { message: "run task" });

    expect(getCompatibilityEventTypes(events)).toEqual([
      "session.started",
      "turn.started",
      "message.received",
      "step.started",
      "message.completed",
      "step.completed",
      "turn.completed",
      "session.completed",
    ]);
  });

  it("emits actions.requested and action.result on tool call step", async () => {
    setupMockAgent({
      finishReason: "tool-calls",
      response: {
        messages: [
          {
            content: [
              { text: "Let me add those.", type: "text" },
              { input: { a: 1, b: 2 }, toolCallId: "call-1", toolName: "add", type: "tool-call" },
            ],
            role: "assistant",
          },
          {
            content: [{ output: "42", toolCallId: "call-1", toolName: "add", type: "tool-result" }],
            role: "tool",
          },
        ],
      },
      text: "",
      toolCalls: [
        { input: { a: 1, b: 2 }, toolCallId: "call-1", toolName: "add", type: "tool-call" },
      ],
      toolResults: [
        {
          input: { a: 1, b: 2 },
          output: "42",
          toolCallId: "call-1",
          toolName: "add",
          type: "tool-result",
        },
      ],
    });

    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(createTestConfig("conversation", emit));

    await runStep(createTestSession(), { message: "Add 1 and 2" });

    expect(getCompatibilityEventTypes(events)).toEqual([
      "session.started",
      "turn.started",
      "message.received",
      "step.started",
      "message.completed",
      "actions.requested",
      "action.result",
      "step.completed",
    ]);

    expect(events.find((e) => e.type === "message.completed")?.data).toEqual({
      finishReason: "tool-calls",
      message: "Let me add those.",
      sequence: 0,
      stepIndex: 0,
      turnId: "turn_0",
    });

    expect(events.find((e) => e.type === "step.completed")?.data).toEqual({
      finishReason: "tool-calls",
      sequence: 0,
      stepIndex: 0,
      turnId: "turn_0",
    });

    expect(events.find((e) => e.type === "actions.requested")?.data).toEqual({
      actions: [{ callId: "call-1", input: { a: 1, b: 2 }, kind: "tool-call", toolName: "add" }],
      sequence: 0,
      stepIndex: 0,
      turnId: "turn_0",
    });

    expect(events.find((e) => e.type === "action.result")?.data).toEqual({
      result: { callId: "call-1", kind: "tool-result", output: "42", toolName: "add" },
      sequence: 0,
      stepIndex: 0,
      status: "completed",
      turnId: "turn_0",
    });
  });

  it("skips AI-SDK-marked invalid tool calls so a malformed JSON payload does not crash the harness", async () => {
    // Simulates the AI SDK fallback path: when the model emits unparsable
    // JSON for a tool call, `parseToolCall` returns a DynamicToolCall with
    // `invalid: true, dynamic: true, input: <raw string>`. eve must not
    // project this into a RuntimeActionRequest (parseJsonObject would
    // throw on a string) and must not surface the call via
    // actions.requested — the AI SDK feeds the error back to the model
    // automatically on the next step via response.messages.
    setupMockAgent({
      finishReason: "tool-calls",
      response: {
        messages: [
          {
            content: [
              { text: "Let me finalize that.", type: "text" },
              {
                // The AI SDK still emits the raw string in the assistant
                // message so the model sees what it sent back on retry.
                input: '{"answer": "...", "keyObservations": \n- bullet',
                toolCallId: "call-bad",
                toolName: "add",
                type: "tool-call",
              },
            ],
            role: "assistant",
          },
        ],
      },
      text: "",
      toolCalls: [
        {
          dynamic: true,
          error: new Error("SyntaxError: Unexpected token in JSON"),
          input: '{"answer": "...", "keyObservations": \n- bullet',
          invalid: true,
          toolCallId: "call-bad",
          toolName: "add",
          type: "tool-call",
        },
      ],
      toolResults: [],
    });

    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(createTestConfig("conversation", emit));

    // Must not throw.
    await expect(runStep(createTestSession(), { message: "Do it" })).resolves.toBeDefined();

    // The invalid call must be absent from the action event stream.
    expect(events.some((event) => event.type === "actions.requested")).toBe(false);
    expect(events.some((event) => event.type === "action.result")).toBe(false);

    // The recoverable-failure path must not fire — the step completes
    // normally so the next turn can feed the SDK's tool-error back to
    // the model.
    expect(events.some((event) => event.type === "turn.failed")).toBe(false);
    expect(events.find((event) => event.type === "step.completed")?.data).toMatchObject({
      finishReason: "tool-calls",
    });
  });

  it("feeds non-object tool call input back to the model as a failed tool result", async () => {
    const invalidInput = "not an object";
    const errorMessage =
      'Failed to parse tool-call arguments for "add" (call-bad): Expected a JSON-serializable object.';
    setupMockAgent({
      finishReason: "tool-calls",
      response: {
        messages: [
          {
            content: [
              {
                input: invalidInput,
                toolCallId: "call-bad",
                toolName: "add",
                type: "tool-call",
              },
            ],
            role: "assistant",
          },
        ],
      },
      text: "",
      toolCalls: [
        {
          input: invalidInput,
          toolCallId: "call-bad",
          toolName: "add",
          type: "tool-call",
        },
      ],
      toolResults: [],
    });

    const { emit } = createEventCollector();
    const runStep = createToolLoopHarness(createTestConfig("conversation", emit));
    const firstStep = await runStep(createTestSession(), { message: "Add these" });

    expect(firstStep.next).toBe(runStep);
    expect(firstStep.session.history).toEqual([
      { content: "Add these", role: "user" },
      {
        content: [
          {
            input: invalidInput,
            toolCallId: "call-bad",
            toolName: "add",
            type: "tool-call",
          },
        ],
        role: "assistant",
      },
      {
        content: [
          {
            output: { type: "error-text", value: errorMessage },
            toolCallId: "call-bad",
            toolName: "add",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ]);

    setupMockAgent({
      finishReason: "stop",
      response: {
        messages: [{ content: "I'll use object arguments next time.", role: "assistant" }],
      },
      text: "I'll use object arguments next time.",
      toolCalls: [],
      toolResults: [],
    });
    await runStep(firstStep.session);

    const secondInstance = vi.mocked(ToolLoopAgent).mock.results[1]?.value as
      | { stream: ReturnType<typeof vi.fn> }
      | undefined;
    const secondCall = secondInstance?.stream.mock.calls[0]?.[0] as
      | { messages: ModelMessage[] }
      | undefined;
    expect(secondCall?.messages).toEqual(firstStep.session.history);
    expect(secondCall?.messages.at(-1)).toEqual({
      content: [
        {
          output: { type: "error-text", value: errorMessage },
          toolCallId: "call-bad",
          toolName: "add",
          type: "tool-result",
        },
      ],
      role: "tool",
    });
  });

  it("only emits valid tool calls when a step mixes valid and invalid tool calls", async () => {
    setupMockAgent({
      finishReason: "tool-calls",
      response: {
        messages: [
          {
            content: [
              { text: "Two tools.", type: "text" },
              { input: { a: 1, b: 2 }, toolCallId: "call-ok", toolName: "add", type: "tool-call" },
              {
                input: '{"bad":',
                toolCallId: "call-bad",
                toolName: "add",
                type: "tool-call",
              },
            ],
            role: "assistant",
          },
          {
            content: [{ output: "3", toolCallId: "call-ok", toolName: "add", type: "tool-result" }],
            role: "tool",
          },
        ],
      },
      text: "",
      toolCalls: [
        { input: { a: 1, b: 2 }, toolCallId: "call-ok", toolName: "add", type: "tool-call" },
        {
          dynamic: true,
          error: new Error("SyntaxError"),
          input: '{"bad":',
          invalid: true,
          toolCallId: "call-bad",
          toolName: "add",
          type: "tool-call",
        },
      ],
      toolResults: [
        {
          input: { a: 1, b: 2 },
          output: "3",
          toolCallId: "call-ok",
          toolName: "add",
          type: "tool-result",
        },
      ],
    });

    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(createTestConfig("conversation", emit));

    await runStep(createTestSession(), { message: "Add 1 and 2" });

    expect(events.find((event) => event.type === "actions.requested")?.data).toEqual({
      actions: [{ callId: "call-ok", input: { a: 1, b: 2 }, kind: "tool-call", toolName: "add" }],
      sequence: 0,
      stepIndex: 0,
      turnId: "turn_0",
    });

    const actionResults = events.filter((event) => event.type === "action.result");
    expect(actionResults).toHaveLength(1);
    expect(actionResults[0]?.data).toMatchObject({
      result: { callId: "call-ok", kind: "tool-result", output: "3", toolName: "add" },
    });
  });

  it("skips invalid runtime-action tool calls instead of parking them in the pending batch", async () => {
    setupMockAgent({
      finishReason: "tool-calls",
      response: {
        messages: [
          {
            content: [
              { text: "Invoking subagent.", type: "text" },
              {
                input: '{"malformed',
                toolCallId: "call-subagent-bad",
                toolName: "delegate",
                type: "tool-call",
              },
            ],
            role: "assistant",
          },
        ],
      },
      text: "",
      toolCalls: [
        {
          dynamic: true,
          error: new Error("SyntaxError"),
          input: '{"malformed',
          invalid: true,
          toolCallId: "call-subagent-bad",
          toolName: "delegate",
          type: "tool-call",
        },
      ],
      toolResults: [],
    });

    const { emit, events } = createEventCollector();
    const session = createTestSession();
    const config = createTestConfig("conversation", emit, {
      tools: new Map([
        [
          "delegate",
          {
            description: "Delegate to a subagent.",
            inputSchema: jsonSchema({ type: "object" }),
            name: "delegate",
            runtimeAction: {
              kind: "subagent-call",
              nodeId: "workers",
              subagentName: "worker",
            },
          },
        ],
      ]),
    });

    const runStep = createToolLoopHarness(config);
    const result = await runStep(session, { message: "Go" });

    // No crash, no parked runtime-action batch — the invalid call is
    // dropped so the AI SDK's tool-error feedback drives the next step.
    expect(result.session.state?.["eve.runtime.pendingActionBatch"]).toBeUndefined();
    expect(events.some((event) => event.type === "actions.requested")).toBe(false);
    expect(events.some((event) => event.type === "turn.failed")).toBe(false);
  });

  it("stamps the live emission state onto a parked runtime-action batch so resume is a continuation", async () => {
    setupMockAgent({
      finishReason: "tool-calls",
      response: {
        messages: [
          {
            content: [
              { text: "Delegating.", type: "text" },
              {
                input: { task: "do it" },
                toolCallId: "call-subagent",
                toolName: "delegate",
                type: "tool-call",
              },
            ],
            role: "assistant",
          },
        ],
      },
      text: "",
      toolCalls: [
        {
          input: { task: "do it" },
          toolCallId: "call-subagent",
          toolName: "delegate",
          type: "tool-call",
        },
      ],
      toolResults: [],
    });

    const { emit } = createEventCollector();
    const config = createTestConfig("conversation", emit, {
      tools: new Map([
        [
          "delegate",
          {
            description: "Delegate to a subagent.",
            inputSchema: jsonSchema({ type: "object" }),
            name: "delegate",
            runtimeAction: { kind: "subagent-call", nodeId: "workers", subagentName: "worker" },
          },
        ],
      ]),
    });

    const runStep = createToolLoopHarness(config);
    const result = await runStep(createTestSession(), { message: "Go" });

    // Parked on the runtime-action batch.
    expect(result.next).toBeNull();
    expect(result.session.state?.["eve.runtime.pendingActionBatch"]).toBeDefined();

    // The parked session must carry the live turn's emission identity so
    // the resume turn is classified as a continuation, not a fresh turn.
    // Regression: the runtime-action park previously dropped the
    // post-preamble emission update, persisting the default `turnId: ""`,
    // which mis-routed the resume through the fresh-turn lifecycle path.
    const emission = getHarnessEmissionState(result.session.state);
    expect(emission.turnId).toBe("turn_0");
    expect(emission.sessionStarted).toBe(true);
    expect(isHarnessBetweenTurns(result.session)).toBe(false);
  });

  it("emits failed action.result from tool response messages when the stream and toolResults omit it", async () => {
    setupMockAgent({
      finishReason: "tool-calls",
      fullStreamParts: [
        { id: "text-1", text: "Let me try that.", type: "text-delta" },
        {
          input: { city: "Vienna" },
          toolCallId: "call-1",
          toolName: "add",
          type: "tool-call",
        },
        { finishReason: "tool-calls", type: "finish-step" },
      ],
      response: {
        messages: [
          {
            content: [
              { text: "Let me try that.", type: "text" },
              {
                input: { city: "Vienna" },
                toolCallId: "call-1",
                toolName: "add",
                type: "tool-call",
              },
            ],
            role: "assistant",
          },
          {
            content: [
              {
                output: { type: "error-text", value: "Temporary E2E crash for Vienna" },
                toolCallId: "call-1",
                toolName: "add",
                type: "tool-result",
              },
            ],
            role: "tool",
          },
        ],
      },
      text: "",
      toolCalls: [
        {
          input: { city: "Vienna" },
          toolCallId: "call-1",
          toolName: "add",
          type: "tool-call",
        },
      ],
      toolResults: [],
    });

    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(createTestConfig("conversation", emit));

    await runStep(createTestSession(), { message: "Weather in Vienna" });

    expect(events.find((event) => event.type === "action.result")?.data).toEqual({
      error: {
        code: "ACTION_RESULT_FAILED",
        message: "Temporary E2E crash for Vienna",
      },
      result: {
        callId: "call-1",
        isError: true,
        kind: "tool-result",
        output: "Temporary E2E crash for Vienna",
        toolName: "add",
      },
      sequence: 0,
      stepIndex: 0,
      status: "failed",
      turnId: "turn_0",
    });
  });

  it("continues the tool loop when load_skill fails during local tool execution", async () => {
    setupMockAgent({
      content: [
        {
          input: { skill: "missing-demo-skill" },
          toolCallId: "call-load-skill",
          toolName: "load_skill",
          type: "tool-call",
        },
      ],
      finishReason: "tool-calls",
      fullStreamParts: [
        {
          input: { skill: "missing-demo-skill" },
          toolCallId: "call-load-skill",
          toolName: "load_skill",
          type: "tool-call",
        },
        {
          error: new Error(
            'No skill named "missing-demo-skill" at /workspace/skills/missing-demo-skill/SKILL.md.',
          ),
          input: { skill: "missing-demo-skill" },
          toolCallId: "call-load-skill",
          toolName: "load_skill",
          type: "tool-error",
        },
        { finishReason: "tool-calls", type: "finish-step" },
      ],
      response: {
        messages: [
          {
            content: [
              {
                input: { skill: "missing-demo-skill" },
                toolCallId: "call-load-skill",
                toolName: "load_skill",
                type: "tool-call",
              },
            ],
            role: "assistant",
          },
        ],
      },
      text: "",
      toolCalls: [
        {
          input: { skill: "missing-demo-skill" },
          toolCallId: "call-load-skill",
          toolName: "load_skill",
          type: "tool-call",
        },
      ],
      toolResults: [],
    });

    const { emit, events } = createEventCollector();
    const config = createTestConfig("conversation", emit, {
      tools: new Map([
        [
          "load_skill",
          {
            description: "Load a skill.",
            execute: vi.fn(),
            inputSchema: jsonSchema({ type: "object" }),
            name: "load_skill",
          },
        ],
      ]),
    });
    const session = createTestSession({
      agent: {
        modelReference: { id: "test-model" },
        system: "You are a test assistant.",
        tools: [
          {
            description: "Load a skill.",
            inputSchema: { type: "object" },
            name: "load_skill",
          },
        ],
      },
    });

    const result = await createToolLoopHarness(config)(session, {
      message: "Use the missing demo skill.",
    });

    expect(typeof result.next).toBe("function");
    expect(events.find((event) => event.type === "action.result")?.data).toEqual({
      error: {
        code: "ACTION_RESULT_FAILED",
        message:
          'No skill named "missing-demo-skill" at /workspace/skills/missing-demo-skill/SKILL.md.',
      },
      result: {
        callId: "call-load-skill",
        isError: true,
        kind: "tool-result",
        output:
          'No skill named "missing-demo-skill" at /workspace/skills/missing-demo-skill/SKILL.md.',
        toolName: "load_skill",
      },
      sequence: 0,
      stepIndex: 0,
      status: "failed",
      turnId: "turn_0",
    });
    expect(result.session.history.slice(-2)).toEqual([
      {
        content: [
          {
            input: { skill: "missing-demo-skill" },
            toolCallId: "call-load-skill",
            toolName: "load_skill",
            type: "tool-call",
          },
        ],
        role: "assistant",
      },
      {
        content: [
          {
            output: {
              type: "error-text",
              value:
                'No skill named "missing-demo-skill" at /workspace/skills/missing-demo-skill/SKILL.md.',
            },
            toolCallId: "call-load-skill",
            toolName: "load_skill",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ]);
    expect(events.some((event) => event.type === "turn.failed")).toBe(false);
    expect(events.some((event) => event.type === "session.failed")).toBe(false);
  });

  it("prefers toolResults over response messages when the stream omits the result", async () => {
    setupMockAgent({
      finishReason: "tool-calls",
      fullStreamParts: [
        { id: "text-1", text: "Let me try that.", type: "text-delta" },
        {
          input: { city: "Vienna" },
          toolCallId: "call-1",
          toolName: "add",
          type: "tool-call",
        },
        { finishReason: "tool-calls", type: "finish-step" },
      ],
      response: {
        messages: [
          {
            content: [
              { text: "Let me try that.", type: "text" },
              {
                input: { city: "Vienna" },
                toolCallId: "call-1",
                toolName: "add",
                type: "tool-call",
              },
            ],
            role: "assistant",
          },
          {
            content: [
              {
                output: { type: "error-text", value: "Temporary E2E crash for Vienna" },
                toolCallId: "call-1",
                toolName: "add",
                type: "tool-result",
              },
            ],
            role: "tool",
          },
        ],
      },
      text: "",
      toolCalls: [
        {
          input: { city: "Vienna" },
          toolCallId: "call-1",
          toolName: "add",
          type: "tool-call",
        },
      ],
      toolResults: [
        {
          output: "Structured tool result wins",
          toolCallId: "call-1",
          toolName: "add",
          type: "tool-result",
        },
      ],
    });

    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(createTestConfig("conversation", emit));

    await runStep(createTestSession(), { message: "Weather in Vienna" });

    const actionResults = events.filter((event) => event.type === "action.result");
    expect(actionResults).toHaveLength(1);
    expect(actionResults[0]?.data).toEqual({
      result: {
        callId: "call-1",
        kind: "tool-result",
        output: "Structured tool result wins",
        toolName: "add",
      },
      sequence: 0,
      stepIndex: 0,
      status: "completed",
      turnId: "turn_0",
    });
  });

  it("propagates streamed cancellation without waiting for onStepFinish or emitting failures", async () => {
    const abortController = new AbortController();
    const abortReason = new TurnCancelledError();

    vi.mocked(ToolLoopAgent).mockImplementation(function (
      this: ToolLoopAgent,
      settings: MockAgentSettings,
    ) {
      this.stream = vi
        .fn()
        .mockImplementation(async (options: { abortSignal?: AbortSignal; messages: unknown[] }) => {
          expect(options.abortSignal).toBe(abortController.signal);
          if (settings.prepareStep) {
            await settings.prepareStep({
              context: undefined,
              messages: options.messages,
              model: {},
              stepNumber: 0,
              steps: [],
            });
          }

          return {
            fullStream: (async function* () {
              abortController.abort(abortReason);
              yield { reason: abortReason.message, type: "abort" };
            })(),
            steps: new Promise<never>(() => {}),
          };
        });
      return this;
    } as MockAgentConstructor);

    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(
      createTestConfig("conversation", emit, { abortSignal: abortController.signal }),
    );

    await expect(runStep(createTestSession(), { message: "Hi" })).rejects.toBe(abortReason);

    const eventTypes = events.map((event) => event.type);
    expect(eventTypes).not.toContain("step.failed");
    expect(eventTypes).not.toContain("turn.failed");
    expect(eventTypes).not.toContain("session.failed");
  });

  it("does not retry or recover a model call once the turn signal has aborted", async () => {
    const abortController = new AbortController();
    const cancellation = new TurnCancelledError();
    const streamMock = vi.fn().mockImplementation(async () => {
      abortController.abort(cancellation);
      throw Object.assign(new Error("socket hang up"), { isRetryable: true });
    });
    vi.mocked(ToolLoopAgent).mockImplementation(function (this: ToolLoopAgent) {
      this.stream = streamMock;
      this.generate = streamMock;
      return this;
    } as MockAgentConstructor);

    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(
      createTestConfig("conversation", emit, { abortSignal: abortController.signal }),
    );

    await expect(runStep(createTestSession(), { message: "Hi" })).rejects.toBe(cancellation);
    expect(streamMock).toHaveBeenCalledTimes(1);

    const eventTypes = events.map((event) => event.type);
    expect(eventTypes).not.toContain("step.failed");
    expect(eventTypes).not.toContain("turn.failed");
    expect(eventTypes).not.toContain("session.failed");
  });

  it("does not start a model call when the turn signal is already aborted", async () => {
    const abortController = new AbortController();
    const cancellation = new TurnCancelledError();
    abortController.abort(cancellation);

    const streamMock = vi.fn();
    vi.mocked(ToolLoopAgent).mockImplementation(function (this: ToolLoopAgent) {
      this.stream = streamMock;
      this.generate = streamMock;
      return this;
    } as MockAgentConstructor);

    const { emit } = createEventCollector();
    const runStep = createToolLoopHarness(
      createTestConfig("conversation", emit, { abortSignal: abortController.signal }),
    );

    await expect(runStep(createTestSession(), { message: "Hi" })).rejects.toBe(cancellation);
    expect(streamMock).not.toHaveBeenCalled();
  });

  it("emits a recoverable failure cascade and parks the session on a non-terminal model-call error", async () => {
    setupMockAgentError(new Error("Model blew up"));

    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(createTestConfig("conversation", emit));

    const result = await runStep(createTestSession(), { message: "Hi" });

    // A plain Error defaults to the recoverable classification — the
    // session parks (`next: null`) so the user can follow up in the
    // same thread rather than the whole run being torn down.
    expect(result.next).toBeNull();

    const types = events.map((e) => e.type);
    expect(types).toContain("session.started");
    expect(types).toContain("step.failed");
    expect(types).toContain("turn.failed");
    expect(types).toContain("session.waiting");
    // The recoverable path must not emit session.failed — that event
    // signals a terminal outcome to channel adapters.
    expect(types).not.toContain("session.failed");

    const stepFailed = events.find((e) => e.type === "step.failed");
    expect(stepFailed).toBeDefined();
    expect(stepFailed!.data).toMatchObject({
      code: "MODEL_CALL_FAILED",
      message: "Model blew up",
    });
    expect((stepFailed!.data as { details?: { errorId?: string } }).details?.errorId).toBeDefined();
  });

  it("parks the session on an ambiguous GatewayInternalServerError 400 model-call error", async () => {
    setupMockAgentError(
      createGatewayModelCallError({
        gatewayName: "GatewayInternalServerError",
        gatewayType: "internal_server_error",
        upstreamType: "internal_server_error",
      }),
    );

    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(createTestConfig("conversation", emit));

    const result = await runStep(createTestSession(), { message: "Hi" });

    expect(result.next).toBeNull();

    const types = events.map((e) => e.type);
    expect(types).toContain("step.failed");
    expect(types).toContain("turn.failed");
    expect(types).toContain("session.waiting");
    expect(types).not.toContain("session.failed");

    const stepFailed = events.find((e) => e.type === "step.failed");
    expect(stepFailed).toBeDefined();
    expect(stepFailed!.data).toMatchObject({
      code: "MODEL_CALL_FAILED",
      details: {
        gatewayName: "GatewayInternalServerError",
        gatewayType: "internal_server_error",
        generationId: "gen_tool_loop",
        responseBodySnippet: expect.stringContaining("internal_server_error"),
        statusCode: 400,
        upstreamMessage: "Bad Request",
        upstreamStatusCode: 400,
        upstreamType: "internal_server_error",
      },
      message: "AI Gateway rejected the model request before the agent produced a response.",
    });
    expect(JSON.stringify((stepFailed!.data as { details?: unknown }).details)).not.toContain(
      "large schema",
    );
  });

  it("emits the full terminal failure cascade on a structural 4xx model-call error", async () => {
    // 400/401/403/404 responses are classified as terminal — the
    // session is torn down because retrying would hit the same wall.
    const error = Object.assign(new Error("invalid api key"), {
      name: "AI_APICallError",
      statusCode: 401,
    });
    setupMockAgentError(error);

    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(createTestConfig("conversation", emit));

    const result = await runStep(createTestSession(), { message: "Hi" });

    expect(result.next).toEqual({ done: true, output: "" });

    const types = events.map((e) => e.type);
    expect(types).toContain("step.failed");
    expect(types).toContain("turn.failed");
    expect(types).toContain("session.failed");
    expect(types).not.toContain("session.waiting");
  });

  it("surfaces a terminal model-call error to the parent as a failed task result", async () => {
    // Regression test for https://github.com/vercel/eve/issues/412 — a
    // delegated subagent runs in task mode; when its model id does not
    // resolve (terminal 404), the failure must reach the parent as an
    // error result, not a successful empty output.
    const error = Object.assign(new Error("No endpoints found for anthropic/claude-3.5-haiku"), {
      name: "AI_APICallError",
      statusCode: 404,
    });
    setupMockAgentError(error);

    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(createTestConfig("task", emit));

    const result = await runStep(createTestSession(), { message: "Delegated task" });

    // The task's terminal result must be marked as an error with the
    // failure message as output, mirroring the non-terminal task-mode
    // failure shape. Today the terminal branch returns
    // `{ done: true, output: "" }`, which the parent driver treats as a
    // successful delegation with empty output.
    expect(result.next).toMatchObject({
      done: true,
      isError: true,
      output: expect.stringContaining("No endpoints found for anthropic/claude-3.5-haiku"),
    });

    const types = events.map((e) => e.type);
    expect(types).toContain("step.failed");
    expect(types).toContain("turn.failed");
    expect(types).toContain("session.failed");
  });

  it("emits the full terminal failure cascade on an explicit Gateway invalid-request error", async () => {
    setupMockAgentError(
      createGatewayModelCallError({
        gatewayName: "GatewayInvalidRequestError",
        gatewayType: "invalid_request_error",
        upstreamType: "invalid_request_error",
      }),
    );

    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(createTestConfig("conversation", emit));

    const result = await runStep(createTestSession(), { message: "Hi" });

    expect(result.next).toEqual({ done: true, output: "" });

    const types = events.map((e) => e.type);
    expect(types).toContain("step.failed");
    expect(types).toContain("turn.failed");
    expect(types).toContain("session.failed");
    expect(types).not.toContain("session.waiting");

    const stepFailed = events.find((e) => e.type === "step.failed");
    expect(stepFailed).toBeDefined();
    expect(stepFailed!.data).toMatchObject({
      details: {
        gatewayName: "GatewayInvalidRequestError",
        gatewayType: "invalid_request_error",
        statusCode: 400,
        upstreamType: "invalid_request_error",
      },
    });
    expect(JSON.stringify((stepFailed!.data as { details?: unknown }).details)).not.toContain(
      "large schema",
    );
  });

  describe("unsupported provider tool recovery", () => {
    /**
     * Builds an AI Gateway 400 error whose `data` field encodes one or more
     * "tool type 'X' is not supported" provider-attempt rejections — the
     * shape returned by AI Gateway when a fallback provider rejects a
     * provider-specific tool.
     */
    function createGatewayUnsupportedToolError(input: {
      readonly unsupportedTypes: readonly string[];
    }): Error {
      const responseBodyValue = {
        error: { message: "Bad Request", type: "AI_APICallError" },
        providerMetadata: {
          gateway: {
            routing: {
              originalModelId: "anthropic/claude-opus-4.7",
              modelAttempts: [
                {
                  canonicalSlug: "anthropic/claude-opus-4.7",
                  success: false,
                  providerAttempts: [
                    {
                      provider: "anthropic",
                      success: false,
                      error: "Service temporarily unavailable",
                      statusCode: 503,
                    },
                    ...input.unsupportedTypes.map((type) => ({
                      provider: "bedrock",
                      success: false,
                      error: `tool type '${type}' is not supported for this model`,
                      statusCode: 400,
                    })),
                  ],
                },
              ],
            },
          },
        },
      };
      const upstream = Object.assign(new Error("[object Object]"), {
        data: responseBodyValue,
        isRetryable: false,
        name: "AI_APICallError",
        responseBody: JSON.stringify(responseBodyValue),
        statusCode: 400,
      });
      return Object.assign(
        new Error("GatewayInternalServerError: Bad Request", { cause: upstream }),
        {
          isRetryable: false,
          name: "GatewayInternalServerError",
          statusCode: 400,
          type: "internal_server_error",
        },
      );
    }

    /**
     * Wires the mocked ToolLoopAgent so the first constructed instance
     * fails its model call with `failure`, and any later instance returns
     * `successResult`. Used to exercise the within-step recovery retry
     * without re-running the entire harness.
     */
    function setupRecoveryAgent(input: {
      readonly failure: Error;
      readonly successResult: Record<string, unknown>;
    }): { readonly constructedCalls: { readonly count: () => number } } {
      let constructionIndex = 0;
      vi.mocked(ToolLoopAgent).mockImplementation(function (
        this: Record<string, unknown>,
        settings: MockAgentSettings,
      ) {
        const { onStepFinish, prepareStep } = settings;
        const isFirst = constructionIndex === 0;
        constructionIndex += 1;
        if (isFirst) {
          // The real AI SDK runs `prepareStep` before the model call
          // is dispatched, so `step.started` is emitted before the
          // upstream rejection arrives. Mirror that ordering in the
          // mock so the test can assert step.started is emitted
          // exactly once across the original + retry attempts.
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
            throw input.failure;
          });
          this.stream = vi.fn().mockImplementation(async (options: { messages: unknown[] }) => {
            if (prepareStep) {
              await prepareStep({
                messages: options.messages,
                steps: [],
                stepNumber: 0,
                model: {},
                context: undefined,
              });
            }
            throw input.failure;
          });
        } else {
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
            if (onStepFinish) await onStepFinish(input.successResult);
            return input.successResult;
          });
          this.stream = vi.fn().mockImplementation(async (options: { messages: unknown[] }) => {
            if (prepareStep) {
              await prepareStep({
                messages: options.messages,
                steps: [],
                stepNumber: 0,
                model: {},
                context: undefined,
              });
            }
            const mockResult = createMockStreamResult(input.successResult);
            if (onStepFinish) {
              void Promise.resolve().then(() => onStepFinish(input.successResult));
            }
            return mockResult;
          });
        }
        return this as unknown as ToolLoopAgent;
      } as unknown as MockAgentConstructor);
      return { constructedCalls: { count: () => constructionIndex } };
    }

    afterEach(() => {
      // vi.clearAllMocks does not drain an unconsumed mockImplementationOnce.
      // Reset so a test that fails before its first agent construction cannot
      // leak the queued fixture into later suites.
      vi.mocked(ToolLoopAgent).mockReset();
    });

    it("keeps the degraded toolset when the dropped-tool retry comes back empty", async () => {
      const emptyResult: Record<string, unknown> = {
        content: [],
        finishReason: "other",
        response: { messages: [] },
        text: "",
        toolCalls: [],
        toolResults: [],
        usage: {},
      };
      const successResult: Record<string, unknown> = {
        finishReason: "stop",
        response: { messages: [{ content: "ok", role: "assistant" }] },
        text: "ok",
        toolCalls: [],
        toolResults: [],
      };
      // Construction order: gateway tool rejection, then the degraded
      // retry resolving empty, then the empty-response reissue.
      setupMockAgentError(
        createGatewayUnsupportedToolError({ unsupportedTypes: ["web_search_20250305"] }),
      );
      const throwImpl = vi.mocked(ToolLoopAgent).getMockImplementation();
      setupMockAgent(emptyResult);
      const emptyImpl = vi.mocked(ToolLoopAgent).getMockImplementation();
      setupMockAgent(successResult);
      vi.mocked(ToolLoopAgent)
        .mockImplementationOnce(throwImpl!)
        .mockImplementationOnce(emptyImpl!);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const session = createTestSession({
        agent: {
          modelReference: { id: "anthropic/claude-opus-4.7" },
          system: "You are a test assistant.",
          tools: [
            { description: "Adds numbers", name: "add", inputSchema: { type: "object" } },
            { description: "Web search.", name: "web_search", inputSchema: null },
          ],
        },
      });
      const config: ToolLoopHarnessConfig = {
        mode: "conversation",
        resolveModel: vi.fn().mockResolvedValue("anthropic/claude-opus-4.7"),
        tools: new Map([
          [
            "add",
            {
              description: "Adds numbers",
              execute: vi.fn(),
              inputSchema: jsonSchema({ type: "object" }),
              name: "add",
            },
          ],
          [
            "web_search",
            {
              description: "Web search.",
              inputSchema: jsonSchema({}),
              name: "web_search",
            },
          ],
        ]),
      };
      const { emit, events } = createEventCollector();
      const runStep = createToolLoopHarness({ ...config, handleEvent: emit });

      try {
        const result = await runStep(session, { message: "Hi" });

        expect(vi.mocked(ToolLoopAgent).mock.calls.length).toBe(3);
        expect(result.next).toBeNull();
        expect(events.map((event) => event.type)).not.toContain("turn.failed");

        // The reissue repeated the degraded call shape: web_search stays
        // dropped and the one-shot system note stays prepended, instead of
        // silently restoring the tool the gateway just rejected.
        const reissueCall = vi.mocked(ToolLoopAgent).mock.calls[2]?.[0];
        const reissueTools = reissueCall!.tools as Record<string, unknown>;
        expect(reissueTools.web_search).toBeUndefined();
        expect(reissueTools.add).toBeDefined();
        const reissueInstructions = reissueCall!.instructions as Array<{
          role: string;
          content: string;
        }>;
        expect(Array.isArray(reissueInstructions)).toBe(true);
        expect(reissueInstructions[0]?.content).toContain("web_search");
        expect(reissueCall!.runtimeContext).toMatchObject({
          "eve.retry.reason": "empty-response",
        });
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("parks recoverably when the dropped-tool retry and its reissue both come back empty", async () => {
      const emptyResult: Record<string, unknown> = {
        content: [],
        finishReason: "other",
        response: { messages: [] },
        text: "",
        toolCalls: [],
        toolResults: [],
        usage: {},
      };
      // Construction order: gateway tool rejection, then every later
      // construction (degraded retry and reissue alike) resolves empty.
      setupMockAgentError(
        createGatewayUnsupportedToolError({ unsupportedTypes: ["web_search_20250305"] }),
      );
      const throwImpl = vi.mocked(ToolLoopAgent).getMockImplementation();
      setupMockAgent(emptyResult);
      vi.mocked(ToolLoopAgent).mockImplementationOnce(throwImpl!);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const session = createTestSession({
        agent: {
          modelReference: { id: "anthropic/claude-opus-4.7" },
          system: "You are a test assistant.",
          tools: [{ description: "Web search.", name: "web_search", inputSchema: null }],
        },
      });
      const config: ToolLoopHarnessConfig = {
        mode: "conversation",
        resolveModel: vi.fn().mockResolvedValue("anthropic/claude-opus-4.7"),
        tools: new Map([
          [
            "web_search",
            {
              description: "Web search.",
              inputSchema: jsonSchema({}),
              name: "web_search",
            },
          ],
        ]),
      };
      const { emit, events } = createEventCollector();
      const runStep = createToolLoopHarness({ ...config, handleEvent: emit });

      try {
        const result = await runStep(session, { message: "Hi" });

        // Rejection, degraded retry, reissue: three calls, then the floor.
        expect(vi.mocked(ToolLoopAgent).mock.calls.length).toBe(3);
        expect(result.next).toBeNull();

        const types = events.map((event) => event.type);
        expect(types).toContain("step.failed");
        expect(types).toContain("turn.failed");
        expect(types).toContain("session.waiting");
        const stepFailed = events.find((event) => event.type === "step.failed");
        expect((stepFailed!.data as { message: string }).message).toContain(
          "did not return a response",
        );
      } finally {
        warnSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });

    it("bails terminally when the empty-response reissue hits a tool rejection", async () => {
      const emptyResult: Record<string, unknown> = {
        content: [],
        finishReason: "other",
        response: { messages: [] },
        text: "",
        toolCalls: [],
        toolResults: [],
        usage: {},
      };
      // Construction order: empty response first, then the reissue throws
      // the gateway tool rejection. The pipeline is linear (the tool stage
      // already ran and skipped), so the rejection falls to the terminal
      // floor instead of looping back into tool-drop recovery.
      setupMockAgentError(
        createGatewayUnsupportedToolError({ unsupportedTypes: ["web_search_20250305"] }),
      );
      const throwImpl = vi.mocked(ToolLoopAgent).getMockImplementation();
      setupMockAgent(emptyResult);
      const emptyImpl = vi.mocked(ToolLoopAgent).getMockImplementation();
      vi.mocked(ToolLoopAgent).mockImplementation(throwImpl!);
      vi.mocked(ToolLoopAgent).mockImplementationOnce(emptyImpl!);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const session = createTestSession({
        agent: {
          modelReference: { id: "anthropic/claude-opus-4.7" },
          system: "You are a test assistant.",
          tools: [{ description: "Web search.", name: "web_search", inputSchema: null }],
        },
      });
      const config: ToolLoopHarnessConfig = {
        mode: "conversation",
        resolveModel: vi.fn().mockResolvedValue("anthropic/claude-opus-4.7"),
        tools: new Map([
          [
            "web_search",
            {
              description: "Web search.",
              inputSchema: jsonSchema({}),
              name: "web_search",
            },
          ],
        ]),
      };
      const { emit, events } = createEventCollector();
      const runStep = createToolLoopHarness({ ...config, handleEvent: emit });

      try {
        const result = await runStep(session, { message: "Hi" });

        // Empty original plus one reissue: two calls, no third attempt.
        expect(vi.mocked(ToolLoopAgent).mock.calls.length).toBe(2);
        expect(result.next).toEqual({ done: true, output: "" });

        const types = events.map((event) => event.type);
        expect(types).toContain("step.failed");
        expect(types).toContain("session.failed");
        expect(types).not.toContain("session.waiting");
      } finally {
        warnSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });

    it("retries with the offending tool dropped and a one-shot system note", async () => {
      const resolveRuntimeContext = vi.fn((input: InstrumentationStepStartedEventInput) => ({
        runtimeContext: {
          "test.attempt": Array.isArray(input.modelInput.instructions) ? "retry" : "original",
        },
      }));
      mockGetInstrumentationConfig.mockReturnValue({
        events: {
          "step.started": resolveRuntimeContext,
        },
      });
      const { constructedCalls } = setupRecoveryAgent({
        failure: createGatewayUnsupportedToolError({ unsupportedTypes: ["web_search_20250305"] }),
        successResult: {
          finishReason: "stop",
          response: { messages: [{ content: "ok", role: "assistant" }] },
          text: "ok",
          toolCalls: [],
          toolResults: [],
        },
      });

      const session = createTestSession({
        agent: {
          modelReference: { id: "anthropic/claude-opus-4.7" },
          system: "You are a test assistant.",
          tools: [
            { description: "Adds numbers", name: "add", inputSchema: { type: "object" } },
            { description: "Web search.", name: "web_search", inputSchema: null },
          ],
        },
      });
      const config: ToolLoopHarnessConfig = {
        mode: "conversation",
        resolveModel: vi.fn().mockResolvedValue("anthropic/claude-opus-4.7"),
        tools: new Map([
          [
            "add",
            {
              description: "Adds numbers",
              execute: vi.fn(),
              inputSchema: jsonSchema({ type: "object" }),
              name: "add",
            },
          ],
          [
            "web_search",
            {
              description: "Web search.",
              inputSchema: jsonSchema({}),
              name: "web_search",
            },
          ],
        ]),
      };

      const { emit, events } = createEventCollector();
      const runStep = createToolLoopHarness({ ...config, handleEvent: emit });
      const result = await runStep(session, { message: "Hi" });

      // The second agent was constructed for the retry.
      expect(constructedCalls.count()).toBe(2);
      expect(resolveRuntimeContext).toHaveBeenCalledTimes(2);

      // The retry succeeded — the session parked normally instead of
      // emitting any failure cascade.
      expect(result.next).toBeNull();
      const types = events.map((e) => e.type);
      expect(types).not.toContain("session.failed");
      expect(types).not.toContain("turn.failed");
      expect(types).not.toContain("step.failed");

      // step.started is emitted exactly once for the recovered step,
      // not twice — the second buildStepHooks call ran with
      // `emitStepStarted: false`.
      expect(types.filter((t) => t === "step.started")).toHaveLength(1);

      // The retry's toolset omitted web_search but kept the other tools.
      const retryCall = vi.mocked(ToolLoopAgent).mock.calls[1]?.[0];
      const retryTools = retryCall!.tools as Record<string, unknown>;
      expect(retryTools.web_search).toBeUndefined();
      expect(retryTools.add).toBeDefined();
      expect(vi.mocked(ToolLoopAgent).mock.calls[0]?.[0].runtimeContext).toMatchObject({
        "test.attempt": "original",
      });
      expect(retryCall!.runtimeContext).toMatchObject({ "test.attempt": "retry" });

      // The retry's instructions prepend a one-shot system note about
      // the removed capability so the model has explicit context.
      const retryInstructions = retryCall!.instructions as
        | string
        | Array<{ role: string; content: string }>;
      expect(Array.isArray(retryInstructions)).toBe(true);
      const noteEntry = (retryInstructions as Array<{ role: string; content: string }>)[0];
      expect(noteEntry?.role).toBe("system");
      expect(noteEntry?.content).toContain("web_search");
      expect(noteEntry?.content).toContain("not available");
      expect(resolveRuntimeContext.mock.calls[1]?.[0].modelInput.instructions).toEqual(
        retryInstructions,
      );
    });

    it("falls through to terminal cascade when recovery retry also fails", async () => {
      // Both attempts fail with the same unsupported-tool error. The
      // existing terminal/recoverable handling runs on the second
      // failure so the session is torn down.
      const error = createGatewayUnsupportedToolError({
        unsupportedTypes: ["web_search_20250305"],
      });
      setupMockAgentError(error);

      const session = createTestSession({
        agent: {
          modelReference: { id: "anthropic/claude-opus-4.7" },
          system: "You are a test assistant.",
          tools: [{ description: "Web search.", name: "web_search", inputSchema: null }],
        },
      });
      const config: ToolLoopHarnessConfig = {
        mode: "conversation",
        resolveModel: vi.fn().mockResolvedValue("anthropic/claude-opus-4.7"),
        tools: new Map([
          [
            "web_search",
            {
              description: "Web search.",
              inputSchema: jsonSchema({}),
              name: "web_search",
            },
          ],
        ]),
      };

      const { emit, events } = createEventCollector();
      const runStep = createToolLoopHarness({ ...config, handleEvent: emit });
      const result = await runStep(session, { message: "Hi" });

      // Two agent constructions: original + retry.
      expect(vi.mocked(ToolLoopAgent).mock.calls.length).toBe(2);

      // 400 with no known summary classifies as terminal, so the
      // cascade is the terminal one.
      expect(result.next).toEqual({ done: true, output: "" });
      const types = events.map((e) => e.type);
      expect(types).toContain("step.failed");
      expect(types).toContain("turn.failed");
      expect(types).toContain("session.failed");
    });

    it("does not retry when the error is unrelated to unsupported provider tools", async () => {
      setupMockAgentError(new Error("Model blew up"));

      const { emit, events } = createEventCollector();
      const runStep = createToolLoopHarness(createTestConfig("conversation", emit));
      await runStep(createTestSession(), { message: "Hi" });

      // Exactly one agent construction — no recovery retry was attempted.
      expect(vi.mocked(ToolLoopAgent).mock.calls.length).toBe(1);

      const types = events.map((e) => e.type);
      // The unrelated error still flows through the recoverable cascade
      // (plain Error defaults to recoverable classification).
      expect(types).toContain("session.waiting");
    });
  });

  describe("empty model response recovery", () => {
    const emptyResult: Record<string, unknown> = {
      content: [],
      finishReason: "other",
      response: { messages: [] },
      text: "",
      toolCalls: [],
      toolResults: [],
      usage: {},
    };

    const successResult: Record<string, unknown> = {
      content: [],
      finishReason: "stop",
      response: { messages: [{ content: "Here is your answer.", role: "assistant" }] },
      text: "Here is your answer.",
      toolCalls: [],
      toolResults: [],
      usage: {},
    };

    const emptyStopResult: Record<string, unknown> = {
      ...emptyResult,
      finishReason: "stop",
      response: { messages: [{ content: " \n", role: "assistant" }] },
      text: " \n",
    };

    /**
     * Stream-rejection shape of the empty response: ai@7.0.0-canary.169+
     * (vercel/ai#15938) enqueues NoOutputGeneratedError onto fullStream
     * and never emits finish-step when a stream closes after metadata
     * without output. Success-shaped base so these tests cannot pass via
     * the empty-step (`finishReason: "other"`) path by accident.
     */
    const noOutputStreamResult: Record<string, unknown> = {
      ...successResult,
      fullStreamParts: [
        {
          error: Object.assign(
            new Error("No output generated. The model stream ended without a finish chunk."),
            { name: "AI_NoOutputGeneratedError" },
          ),
          type: "error",
        },
      ],
    };

    /**
     * Wires the mocked ToolLoopAgent so the first construction resolves
     * with `first` and later constructions resolve with `next`. Each
     * recovery reissue constructs a fresh agent, so the vitest
     * once-queue maps construction order to attempt order.
     */
    function setupFirstThenAgent(
      first: Record<string, unknown>,
      next: Record<string, unknown>,
    ): void {
      setupMockAgent(first);
      const firstImplementation = vi.mocked(ToolLoopAgent).getMockImplementation();
      setupMockAgent(next);
      vi.mocked(ToolLoopAgent).mockImplementationOnce(firstImplementation!);
    }

    afterEach(() => {
      // vi.clearAllMocks does not drain an unconsumed mockImplementationOnce.
      // Reset so a test that fails before its first agent construction cannot
      // leak the queued fixture into later suites.
      vi.mocked(ToolLoopAgent).mockReset();
    });

    it("reissues an empty 'other' response once within the same step and recovers", async () => {
      setupFirstThenAgent(emptyResult, successResult);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { emit, events } = createEventCollector();
      const runStep = createToolLoopHarness(createTestConfig("conversation", emit));

      try {
        const result = await runStep(createTestSession(), { message: "Hi" });

        expect(result.next).toBeNull();
        expect(vi.mocked(ToolLoopAgent).mock.calls.length).toBe(2);
        expect(result.session.history).toContainEqual({
          content: "Here is your answer.",
          role: "assistant",
        });

        // Same-step semantics: the reissue produces no extra protocol steps
        // and no failure events.
        const types = events.map((event) => event.type);
        expect(types).not.toContain("turn.failed");
        expect(types.filter((type) => type === "step.started")).toHaveLength(1);
        expect(types.filter((type) => type === "step.completed")).toHaveLength(1);

        expect(warnSpy).toHaveBeenCalledWith(
          "[eve:harness.tool-loop] empty model response; reissuing the model call once",
          expect.objectContaining({ sessionId: expect.any(String) }),
        );

        // The reissued call's telemetry context labels the retry so the
        // span is identifiable in traces.
        const retryCall = vi.mocked(ToolLoopAgent).mock.calls[1]?.[0];
        expect(retryCall!.runtimeContext).toMatchObject({
          "eve.retry.reason": "empty-response",
        });

        // The reissue appends the wire-only nudge as the trailing message
        // (preserving the cached prompt prefix) and keeps it out of history.
        const reissueAgent = vi.mocked(ToolLoopAgent).mock.results[1]?.value as {
          stream: ReturnType<typeof vi.fn>;
        };
        const reissueMessages = reissueAgent.stream.mock.calls[0]?.[0]?.messages as Array<{
          content: unknown;
          role: string;
        }>;
        expect(reissueMessages.at(-1)).toMatchObject({
          content: expect.stringContaining("was not delivered"),
          role: "user",
        });
        expect(reissueMessages.at(-1)?.content).not.toContain(EMPTY_DELIVERY_SENTINEL);
        expect(
          result.session.history.some(
            (message) =>
              typeof message.content === "string" && message.content.includes("was not delivered"),
          ),
        ).toBe(false);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("offers conditional delivery on an empty-response retry for a scheduled turn", async () => {
      setupFirstThenAgent(emptyResult, successResult);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { emit } = createEventCollector();
      const runStep = createToolLoopHarness(createTestConfig("conversation", emit));

      try {
        await contextStorage.run(createScheduleContext(), () =>
          runStep(createTestSession(), { message: "Check for alerts." }),
        );

        const reissueAgent = vi.mocked(ToolLoopAgent).mock.results[1]?.value as {
          stream: ReturnType<typeof vi.fn>;
        };
        const reissueMessages = reissueAgent.stream.mock.calls[0]?.[0]?.messages as Array<{
          content: unknown;
          role: string;
        }>;
        expect(reissueMessages.at(-1)).toMatchObject({
          content: expect.stringContaining(EMPTY_DELIVERY_SENTINEL),
          role: "user",
        });
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("does not offer conditional delivery on a scheduled retry with an output schema", async () => {
      setupFirstThenAgent(emptyResult, finalOutputResult("Done.", { status: "ok" }));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { emit } = createEventCollector();
      const runStep = createToolLoopHarness(createTestConfig("task", emit));

      try {
        await contextStorage.run(createScheduleContext(), () =>
          runStep(createTestSession({ outputSchema: { type: "object" } }), {
            message: "Check for alerts.",
          }),
        );

        const reissueAgent = vi.mocked(ToolLoopAgent).mock.results[1]?.value as {
          stream: ReturnType<typeof vi.fn>;
        };
        const reissueMessages = reissueAgent.stream.mock.calls[0]?.[0]?.messages as Array<{
          content: unknown;
          role: string;
        }>;
        expect(reissueMessages.at(-1)).toMatchObject({
          content: expect.stringContaining("was not delivered"),
          role: "user",
        });
        expect(reissueMessages.at(-1)?.content).not.toContain(EMPTY_DELIVERY_SENTINEL);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("reissues a blank 'stop' response instead of treating it as intentional silence", async () => {
      setupFirstThenAgent(emptyStopResult, successResult);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const runStep = createToolLoopHarness(createTestConfig("conversation"));

      try {
        const result = await runStep(createTestSession(), { message: "Hi" });

        expect(result.next).toBeNull();
        expect(vi.mocked(ToolLoopAgent)).toHaveBeenCalledTimes(2);
        expect(result.session.history).toContainEqual({
          content: "Here is your answer.",
          role: "assistant",
        });
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("reissues once and recovers when the stream rejects with NoOutputGeneratedError", async () => {
      setupFirstThenAgent(noOutputStreamResult, successResult);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { emit, events } = createEventCollector();
      const runStep = createToolLoopHarness(createTestConfig("conversation", emit));

      try {
        const result = await runStep(createTestSession(), { message: "Hi" });

        expect(result.next).toBeNull();
        expect(vi.mocked(ToolLoopAgent).mock.calls.length).toBe(2);
        expect(result.session.history).toContainEqual({
          content: "Here is your answer.",
          role: "assistant",
        });

        // The SDK rejection funnels into the same one-shot recovery as
        // the empty-step shape: no failure events, no extra steps.
        const types = events.map((event) => event.type);
        expect(types).not.toContain("turn.failed");
        expect(types.filter((type) => type === "step.started")).toHaveLength(1);
        expect(types.filter((type) => type === "step.completed")).toHaveLength(1);

        expect(warnSpy).toHaveBeenCalledWith(
          "[eve:harness.tool-loop] empty model response; reissuing the model call once",
          expect.objectContaining({ sessionId: expect.any(String) }),
        );

        const retryCall = vi.mocked(ToolLoopAgent).mock.calls[1]?.[0];
        expect(retryCall!.runtimeContext).toMatchObject({
          "eve.retry.reason": "empty-response",
        });

        const reissueAgent = vi.mocked(ToolLoopAgent).mock.results[1]?.value as {
          stream: ReturnType<typeof vi.fn>;
        };
        const reissueMessages = reissueAgent.stream.mock.calls[0]?.[0]?.messages as Array<{
          content: unknown;
          role: string;
        }>;
        expect(reissueMessages.at(-1)).toMatchObject({
          content: expect.stringContaining("was not delivered"),
          role: "user",
        });
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("surfaces the empty-response failure when the rejecting stream's reissue also rejects", async () => {
      setupMockAgent(noOutputStreamResult);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { emit, events } = createEventCollector();
      const runStep = createToolLoopHarness(createTestConfig("conversation", emit));

      try {
        const result = await runStep(createTestSession(), { message: "Hi" });

        // Original attempt + one reissue, then bail to the recoverable floor.
        expect(vi.mocked(ToolLoopAgent).mock.calls.length).toBe(2);
        expect(result.next).toBeNull();

        const types = events.map((event) => event.type);
        expect(types).toContain("step.failed");
        expect(types).toContain("turn.failed");
        expect(types).toContain("session.waiting");
        // The channel-visible message is the normalized empty-response
        // text, not the SDK's "No output generated" internals.
        const stepFailed = events.find((event) => event.type === "step.failed");
        expect((stepFailed!.data as { message: string }).message).toContain(
          "did not return a response",
        );
      } finally {
        warnSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });

    it("surfaces a recoverable failure when the reissue also comes back empty", async () => {
      setupMockAgent(emptyResult);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { emit, events } = createEventCollector();
      const runStep = createToolLoopHarness(createTestConfig("conversation", emit));

      try {
        const result = await runStep(createTestSession(), { message: "Hi" });

        // Original attempt + one reissue, then bail to the recoverable floor.
        expect(vi.mocked(ToolLoopAgent).mock.calls.length).toBe(2);
        expect(result.next).toBeNull();

        const types = events.map((event) => event.type);
        expect(types).toContain("step.failed");
        expect(types).toContain("turn.failed");
        expect(types).toContain("session.waiting");
        const stepFailed = events.find((event) => event.type === "step.failed");
        expect((stepFailed!.data as { message: string }).message).toContain(
          "did not return a response",
        );
      } finally {
        warnSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });

    it("fails a task run terminally when the reissue also comes back empty", async () => {
      setupMockAgent(emptyResult);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { emit, events } = createEventCollector();
      const runStep = createToolLoopHarness(createTestConfig("task", emit));

      try {
        const result = await runStep(createTestSession(), { message: "Hi" });

        expect(vi.mocked(ToolLoopAgent).mock.calls.length).toBe(2);
        // A task cannot park for a user retry; the failure is the task's
        // terminal result instead of a `next: null` park that turnWorkflow
        // would reject.
        expect(result.next).toEqual({
          done: true,
          isError: true,
          output: expect.stringContaining("did not return a response"),
        });

        const types = events.map((event) => event.type);
        expect(types).not.toContain("session.waiting");
        expect(types).toContain("step.failed");
        expect(types).toContain("session.failed");
      } finally {
        warnSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });
  });

  it("does not pin gateway routing when web_search is enabled", async () => {
    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "ok", role: "assistant" }] },
      text: "ok",
      toolCalls: [],
      toolResults: [],
    });
    const session = createTestSession({
      agent: {
        modelReference: { id: "anthropic/claude-opus-4.7" },
        system: "",
        tools: [{ description: "Web search.", name: "web_search", inputSchema: null }],
      },
    });
    const config: ToolLoopHarnessConfig = {
      mode: "conversation",
      resolveModel: vi.fn().mockResolvedValue("anthropic/claude-opus-4.7"),
      tools: new Map([
        [
          "web_search",
          {
            description: "Web search.",
            inputSchema: jsonSchema({}),
            name: "web_search",
          },
        ],
      ]),
    };
    const runStep = createToolLoopHarness(config);
    await runStep(session, { message: "hi" });

    const agentCall = vi.mocked(ToolLoopAgent).mock.calls[0]?.[0];
    const prepareStep = getPrepareStep<unknown[], { providerOptions?: unknown }>(
      agentCall?.prepareStep,
    );
    const stepResult = await prepareStep({
      messages: [],
      stepNumber: 0,
      steps: [],
      model: null,
      context: undefined,
    });
    expect(stepResult.providerOptions).toEqual({ gateway: { caching: "auto" } });
  });

  it("emits assistant/tool events in response order when a step completes after tool work", async () => {
    setupMockAgent({
      finishReason: "stop",
      response: {
        messages: [
          {
            content: [
              { text: "I'll search for that.", type: "text" },
              {
                input: { query: "answer to everything" },
                toolCallId: "call-1",
                toolName: "web_search",
                type: "tool-call",
              },
            ],
            role: "assistant",
          },
          {
            content: [
              { output: "42", toolCallId: "call-1", toolName: "web_search", type: "tool-result" },
            ],
            role: "tool",
          },
          { content: "The answer is 42.", role: "assistant" },
        ],
      },
      text: "The answer is 42.",
      toolCalls: [
        {
          input: { query: "answer to everything" },
          toolCallId: "call-1",
          toolName: "web_search",
          type: "tool-call",
        },
      ],
      toolResults: [
        {
          input: { query: "answer to everything" },
          output: "42",
          toolCallId: "call-1",
          toolName: "web_search",
          type: "tool-result",
        },
      ],
    });

    const { emit, events } = createEventCollector();
    const session = createTestSession({
      agent: {
        modelReference: { id: "openai/gpt-5.4" },
        system: "You are a test assistant.",
        tools: [
          { description: "Search the web", name: "web_search", inputSchema: { type: "object" } },
        ],
      },
    });
    const runStep = createToolLoopHarness(
      createTestConfig("conversation", emit, {
        tools: new Map(),
      }),
    );

    await runStep(session, { message: "Search for the answer" });

    expect(getCompatibilityEventTypes(events)).toEqual([
      "session.started",
      "turn.started",
      "message.received",
      "step.started",
      "message.completed",
      "actions.requested",
      "action.result",
      "message.completed",
      "step.completed",
      "turn.completed",
      "session.waiting",
    ]);

    expect(
      events.filter((event) => event.type === "message.completed").map((event) => event.data),
    ).toEqual([
      {
        finishReason: "tool-calls",
        message: "I'll search for that.",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_0",
      },
      {
        finishReason: "stop",
        message: "The answer is 42.",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_0",
      },
    ]);
  });

  it("emits each streamed tool call before its later result", async () => {
    setupMockAgent({
      finishReason: "stop",
      fullStreamParts: [
        { id: "text-1", text: "I'll grab those now.", type: "text-delta" },
        {
          input: { city: "New York" },
          toolCallId: "call-1",
          toolName: "get_weather",
          type: "tool-call",
        },
        {
          output: { condition: "Sunny", temperature: "72 F" },
          toolCallId: "call-1",
          toolName: "get_weather",
          type: "tool-result",
        },
        {
          input: { city: "Los Angeles" },
          toolCallId: "call-2",
          toolName: "get_weather",
          type: "tool-call",
        },
        {
          output: { condition: "Cloudy", temperature: "68 F" },
          toolCallId: "call-2",
          toolName: "get_weather",
          type: "tool-result",
        },
        { id: "text-2", text: "New York is 72 F and Los Angeles is 68 F.", type: "text-delta" },
        { finishReason: "stop", type: "finish-step" },
      ],
      response: {
        messages: [
          {
            content: [
              { text: "I'll grab those now.", type: "text" },
              {
                input: { city: "New York" },
                toolCallId: "call-1",
                toolName: "get_weather",
                type: "tool-call",
              },
              {
                input: { city: "Los Angeles" },
                toolCallId: "call-2",
                toolName: "get_weather",
                type: "tool-call",
              },
            ],
            role: "assistant",
          },
          {
            content: [
              {
                output: { condition: "Sunny", temperature: "72 F" },
                toolCallId: "call-1",
                toolName: "get_weather",
                type: "tool-result",
              },
              {
                output: { condition: "Cloudy", temperature: "68 F" },
                toolCallId: "call-2",
                toolName: "get_weather",
                type: "tool-result",
              },
            ],
            role: "tool",
          },
          { content: "New York is 72 F and Los Angeles is 68 F.", role: "assistant" },
        ],
      },
      text: "New York is 72 F and Los Angeles is 68 F.",
      toolCalls: [
        {
          input: { city: "New York" },
          toolCallId: "call-1",
          toolName: "get_weather",
          type: "tool-call",
        },
        {
          input: { city: "Los Angeles" },
          toolCallId: "call-2",
          toolName: "get_weather",
          type: "tool-call",
        },
      ],
      toolResults: [
        {
          input: { city: "New York" },
          output: { condition: "Sunny", temperature: "72 F" },
          toolCallId: "call-1",
          toolName: "get_weather",
          type: "tool-result",
        },
        {
          input: { city: "Los Angeles" },
          output: { condition: "Cloudy", temperature: "68 F" },
          toolCallId: "call-2",
          toolName: "get_weather",
          type: "tool-result",
        },
      ],
    });

    const { emit, events } = createEventCollector();
    const session = createTestSession({
      agent: {
        modelReference: { id: "anthropic/claude-opus-4.6" },
        system: "You are a test assistant.",
        tools: [
          {
            description: "Get weather for one city",
            name: "get_weather",
            inputSchema: { type: "object" },
          },
        ],
      },
    });
    const runStep = createToolLoopHarness(
      createTestConfig("conversation", emit, {
        tools: new Map(),
      }),
    );

    await runStep(session, { message: "Get the weather for two cities" });

    expect(getCompatibilityEventTypes(events)).toEqual([
      "session.started",
      "turn.started",
      "message.received",
      "step.started",
      "message.completed",
      "actions.requested",
      "action.result",
      "actions.requested",
      "action.result",
      "message.completed",
      "step.completed",
      "turn.completed",
      "session.waiting",
    ]);

    expect(
      events
        .filter((event) => event.type === "actions.requested")
        .map((event) => event.data.actions.map((action) => action.callId)),
    ).toEqual([["call-1"], ["call-2"]]);
  });

  it("emits stream content before step actions", async () => {
    setupMockAgent({
      finishReason: "stop",
      fullStreamParts: [
        { id: "text-1", text: "It is 49 F in NYC.", type: "text-delta" },
        { finishReason: "stop", type: "finish-step" },
      ],
      response: {
        messages: [
          {
            content: [
              {
                input: { query: "nyc weather" },
                toolCallId: "call-1",
                toolName: "web_search",
                type: "tool-call",
              },
            ],
            role: "assistant",
          },
          {
            content: [
              {
                output: { temperature: "49 F" },
                toolCallId: "call-1",
                toolName: "web_search",
                type: "tool-result",
              },
            ],
            role: "tool",
          },
          { content: "It is 49 F in NYC.", role: "assistant" },
        ],
      },
      text: "It is 49 F in NYC.",
      toolCalls: [
        {
          input: { query: "nyc weather" },
          toolCallId: "call-1",
          toolName: "web_search",
          type: "tool-call",
        },
      ],
      toolResults: [
        {
          output: { temperature: "49 F" },
          toolCallId: "call-1",
          toolName: "web_search",
          type: "tool-result",
        },
      ],
      usage: undefined,
    });

    const { emit, events } = createEventCollector();
    const session = createTestSession({
      agent: {
        modelReference: { id: "anthropic/claude-opus-4.6" },
        system: "You are a test assistant.",
        tools: [
          { description: "Search the web", name: "web_search", inputSchema: { type: "object" } },
        ],
      },
    });
    const runStep = createToolLoopHarness(
      createTestConfig("conversation", emit, {
        tools: new Map(),
      }),
    );

    await runStep(session, { message: "Search for NYC weather" });

    expect(getCompatibilityEventTypes(events)).toEqual([
      "session.started",
      "turn.started",
      "message.received",
      "step.started",
      "message.completed",
      "actions.requested",
      "action.result",
      "step.completed",
      "turn.completed",
      "session.waiting",
    ]);
  });

  it("emits action.result before message events when a resumed tool-result lands ahead of the LLM call in the same step", async () => {
    // Simulates the approval-resume path: the AI SDK enqueues the
    // executed tool-result for a previously-parked tool call onto the
    // parent stream before re-entering the LLM call. The tool-call
    // itself was emitted on a prior step's stream, so this stream sees
    // only the result. action.result must precede the message events
    // it informs.
    setupMockAgent({
      finishReason: "stop",
      fullStreamParts: [
        {
          output: "/workspace",
          toolCallId: "call-1",
          toolName: "bash",
          type: "tool-result",
        },
        { id: "text-1", text: "/workspace", type: "text-delta" },
        { finishReason: "stop", type: "finish-step" },
      ],
      response: {
        messages: [{ content: "/workspace", role: "assistant" }],
      },
      text: "/workspace",
      toolCalls: [],
      toolResults: [
        {
          output: "/workspace",
          toolCallId: "call-1",
          toolName: "bash",
          type: "tool-result",
        },
      ],
    });

    const { emit, events } = createEventCollector();
    const session = createTestSession({
      agent: {
        modelReference: { id: "anthropic/claude-opus-4.6" },
        system: "You are a test assistant.",
        tools: [
          { description: "Run shell commands", name: "bash", inputSchema: { type: "object" } },
        ],
      },
    });
    const runStep = createToolLoopHarness(
      createTestConfig("conversation", emit, {
        tools: new Map(),
      }),
    );

    await runStep(session, { message: "run pwd" });

    expect(getCompatibilityEventTypes(events)).toEqual([
      "session.started",
      "turn.started",
      "message.received",
      "step.started",
      "action.result",
      "message.completed",
      "step.completed",
      "turn.completed",
      "session.waiting",
    ]);

    expect(
      events.filter((event) => event.type === "action.result").map((event) => event.data.result),
    ).toEqual([
      {
        callId: "call-1",
        kind: "tool-result",
        output: "/workspace",
        toolName: "bash",
      },
    ]);
  });

  describe("authorization signal detection", () => {
    function createAuthSignals() {
      const full = requestAuthorization([
        {
          name: "protected_action",
          challenge: {
            url: "https://idp.example/auth",
            instructions: "Sign in to continue",
            userCode: "GFI-QLM",
          },
          hookUrl: "https://app.example/callback",
          resume: { nonce: "n1" },
        },
      ]);
      return { full, modelFacing: modelFacingAuthorizationOutput(full) };
    }

    it("emits authorization.required and parks when an approved tool returns an auth signal on the inline resume path", async () => {
      const { full, modelFacing } = createAuthSignals();

      setupMockAgent({
        finishReason: "stop",
        fullStreamParts: [
          {
            output: modelFacing,
            toolCallId: "call-1",
            toolName: "protected_action",
            type: "tool-result",
          },
          { finishReason: "stop", type: "finish-step" },
        ],
        response: { messages: [] },
        text: "",
        toolCalls: [],
        toolResults: [],
      });

      const { emit, events } = createEventCollector();
      const runStep = createToolLoopHarness(
        createTestConfig("conversation", emit, {
          tools: new Map([
            [
              "protected_action",
              {
                description: "Run a protected action",
                execute: vi.fn(),
                inputSchema: jsonSchema({ type: "object" }),
                name: "protected_action",
              },
            ],
          ]),
        }),
      );
      const ctx = new ContextContainer();
      stashToolInterrupt(ctx, "call-1", full);

      const result = await contextStorage.run(ctx, () =>
        runStep(createPendingProtectedActionApprovalSession(), {
          inputResponses: [{ optionId: "approve", requestId: "approval-1" }],
        }),
      );

      expect(result.next).toBeNull();
      expect(getPendingAuthorization(result.session.state)).toEqual({
        challenges: full.challenges,
      });

      const authRequired = events.filter((event) => event.type === "authorization.required");
      expect(authRequired).toHaveLength(1);
      expect(authRequired[0]?.data).toMatchObject({
        authorization: {
          url: "https://idp.example/auth",
          instructions: "Sign in to continue",
          userCode: "GFI-QLM",
        },
        name: "protected_action",
        webhookUrl: "https://app.example/callback",
      });

      const actionResults = events.filter((event) => event.type === "action.result");
      expect(actionResults).toHaveLength(0);
    });

    it("still parks on authorization without emitting action.result when interactive auth fires in the same step", async () => {
      const { full, modelFacing } = createAuthSignals();

      setupMockAgent({
        finishReason: "tool-calls",
        fullStreamParts: [
          {
            input: { action: "run" },
            toolCallId: "call-1",
            toolName: "protected_action",
            type: "tool-call",
          },
          {
            output: modelFacing,
            toolCallId: "call-1",
            toolName: "protected_action",
            type: "tool-result",
          },
          { finishReason: "tool-calls", type: "finish-step" },
        ],
        response: {
          messages: [
            {
              content: [
                {
                  input: { action: "run" },
                  toolCallId: "call-1",
                  toolName: "protected_action",
                  type: "tool-call",
                },
              ],
              role: "assistant",
            },
          ],
        },
        text: "",
        toolCalls: [
          {
            input: { action: "run" },
            toolCallId: "call-1",
            toolName: "protected_action",
            type: "tool-call",
          },
        ],
        toolResults: [
          {
            output: modelFacing,
            toolCallId: "call-1",
            toolName: "protected_action",
            type: "tool-result",
          },
        ],
      });

      const { emit, events } = createEventCollector();
      const runStep = createToolLoopHarness(
        createTestConfig("conversation", emit, {
          tools: new Map([
            [
              "protected_action",
              {
                description: "Run a protected action",
                execute: vi.fn(),
                inputSchema: jsonSchema({ type: "object" }),
                name: "protected_action",
              },
            ],
          ]),
        }),
      );
      const ctx = new ContextContainer();
      stashToolInterrupt(ctx, "call-1", full);

      const result = await contextStorage.run(ctx, () =>
        runStep(createTestSession(), { message: "run protected action" }),
      );

      expect(result.next).toBeNull();
      expect(getPendingAuthorization(result.session.state)).toEqual({
        challenges: full.challenges,
      });

      const authRequired = events.filter((event) => event.type === "authorization.required");
      expect(authRequired).toHaveLength(1);

      const actionResults = events.filter((event) => event.type === "action.result");
      expect(actionResults).toHaveLength(0);
    });
  });

  it("persists the inline approval-resume tool-result into session history so the next turn replays a balanced tool_use / tool_result pair", async () => {
    /*
     * When a previously-parked tool call is approved, the AI SDK
     * enqueues its tool-result onto the parent stream before re-
     * entering the LLM call. The result is absent from
     * `stepResult.response.messages` / `toolCalls` / `toolResults`,
     * so the harness must capture it from the stream and splice it
     * into persisted history. Without this, the next turn replays a
     * `tool_use` block with no matching `tool_result` and Anthropic
     * rejects the request with 400.
     */
    setupMockAgent({
      content: [],
      finishReason: "stop",
      fullStreamParts: [
        {
          output: { exitCode: 0, stderr: "", stdout: "/workspace\n", truncated: false },
          toolCallId: "call-1",
          toolName: "bash",
          type: "tool-result",
        },
        { id: "text-1", text: "`/workspace`", type: "text-delta" },
        { finishReason: "stop", type: "finish-step" },
      ],
      response: {
        messages: [{ content: "`/workspace`", role: "assistant" }],
      },
      text: "`/workspace`",
      toolCalls: [],
      toolResults: [],
    });

    const { emit } = createEventCollector();
    const session = createPendingBashApprovalSession();

    const harness = createToolLoopHarness(
      createTestConfig("conversation", emit, { tools: new Map() }),
    );
    const result = await harness(session, {
      inputResponses: [{ optionId: "approve", requestId: "approval-1" }],
    });

    expect(result.session.history.map((msg) => msg.role)).toEqual([
      "assistant",
      "tool",
      "tool",
      "assistant",
    ]);
    const approvalMessage = result.session.history[1];
    expect(Array.isArray(approvalMessage?.content)).toBe(true);
    const approvalParts = approvalMessage?.content as Array<Record<string, unknown>>;
    expect(approvalParts).toHaveLength(1);
    expect(approvalParts[0]).toEqual({
      approvalId: "approval-1",
      approved: true,
      reason: undefined,
      type: "tool-approval-response",
    });

    const toolResultMessage = result.session.history[2];
    expect(Array.isArray(toolResultMessage?.content)).toBe(true);
    const toolResultParts = toolResultMessage?.content as Array<Record<string, unknown>>;
    expect(toolResultParts).toHaveLength(1);
    expect(toolResultParts[0]).toMatchObject({
      toolCallId: "call-1",
      toolName: "bash",
      type: "tool-result",
    });
    expect(result.session.history.at(-1)?.role).toBe("assistant");
  });

  it("does not persist provider-executed deferred tool-results as generic tool messages", async () => {
    const toolCallId = "srvtoolu_01HhTt9QAEancMSj7jE8CXN7";
    const webSearchOutput = [
      {
        encryptedContent: "encrypted-content",
        pageAge: null,
        title: "Example result",
        type: "web_search_result",
        url: "https://example.com/result",
      },
    ];

    setupMockAgent({
      content: [
        {
          output: webSearchOutput,
          providerExecuted: true,
          toolCallId,
          toolName: "web_search",
          type: "tool-result",
        },
        { text: "Search result captured.", type: "text" },
      ],
      finishReason: "stop",
      fullStreamParts: [
        {
          output: webSearchOutput,
          providerExecuted: true,
          toolCallId,
          toolName: "web_search",
          type: "tool-result",
        },
        { id: "text-1", text: "Search result captured.", type: "text-delta" },
        { finishReason: "stop", type: "finish-step" },
      ],
      response: {
        messages: [
          {
            content: [
              {
                output: { type: "json", value: webSearchOutput },
                toolCallId,
                toolName: "web_search",
                type: "tool-result",
              },
              { text: "Search result captured.", type: "text" },
            ],
            role: "assistant",
          },
        ],
      },
      text: "Search result captured.",
      toolCalls: [],
      toolResults: [
        {
          output: webSearchOutput,
          providerExecuted: true,
          toolCallId,
          toolName: "web_search",
          type: "tool-result",
        },
      ],
    });

    const { emit } = createEventCollector();
    const session = createTestSession({
      agent: {
        modelReference: { id: "anthropic/claude-opus-4.6" },
        system: "You are a test assistant.",
        tools: [{ description: "Search the web", name: "web_search", inputSchema: null }],
      },
      history: [
        { content: "Search release notes.", role: "user" },
        {
          content: [
            {
              input: { query: "eve release note current" },
              providerExecuted: true,
              toolCallId,
              toolName: "web_search",
              type: "tool-call",
            },
          ],
          role: "assistant",
        },
        { content: "Keep working while search resolves.", role: "user" },
      ],
    });

    const harness = createToolLoopHarness(
      createTestConfig("conversation", emit, { tools: new Map() }),
    );

    const result = await harness(session, { message: "continue" });

    const toolMessagesWithServerToolId = result.session.history.filter(
      (message) =>
        message.role === "tool" &&
        Array.isArray(message.content) &&
        message.content.some(
          (part) =>
            part.type === "tool-result" && "toolCallId" in part && part.toolCallId === toolCallId,
        ),
    );
    expect(toolMessagesWithServerToolId).toHaveLength(0);

    const assistantParts = result.session.history.flatMap((message) =>
      message.role === "assistant" && Array.isArray(message.content) ? message.content : [],
    );
    expect(assistantParts).toContainEqual(
      expect.objectContaining({
        toolCallId,
        toolName: "web_search",
        type: "tool-result",
      }),
    );
  });

  it("does not re-emit a provider web_search when its stream call lacks the provider marker", async () => {
    const toolCallId = "srvtoolu_01HhTt9QAEancMSj7jE8CXN7";
    const webSearchOutput = [
      {
        encryptedContent: "encrypted-content",
        pageAge: null,
        title: "Example result",
        type: "web_search_result",
        url: "https://example.com/result",
      },
    ];

    setupMockAgent({
      content: [
        {
          input: { query: "eve release note current" },
          providerExecuted: true,
          toolCallId,
          toolName: "web_search",
          type: "tool-call",
        },
        {
          output: webSearchOutput,
          providerExecuted: true,
          toolCallId,
          toolName: "web_search",
          type: "tool-result",
        },
        { text: "Search result captured.", type: "text" },
      ],
      finishReason: "stop",
      fullStreamParts: [
        {
          input: { query: "eve release note current" },
          toolCallId,
          toolName: "web_search",
          type: "tool-call",
        },
        {
          output: webSearchOutput,
          providerExecuted: true,
          toolCallId,
          toolName: "web_search",
          type: "tool-result",
        },
        { id: "text-1", text: "Search result captured.", type: "text-delta" },
        { finishReason: "stop", type: "finish-step" },
      ],
      response: {
        messages: [
          {
            content: [
              {
                input: { query: "eve release note current" },
                providerExecuted: true,
                toolCallId,
                toolName: "web_search",
                type: "tool-call",
              },
              {
                output: { type: "json", value: webSearchOutput },
                toolCallId,
                toolName: "web_search",
                type: "tool-result",
              },
              { text: "Search result captured.", type: "text" },
            ],
            role: "assistant",
          },
        ],
      },
      text: "Search result captured.",
      toolCalls: [
        {
          input: { query: "eve release note current" },
          toolCallId,
          toolName: "web_search",
          type: "tool-call",
        },
      ],
      toolResults: [
        {
          input: { query: "eve release note current" },
          output: webSearchOutput,
          providerExecuted: true,
          toolCallId,
          toolName: "web_search",
          type: "tool-result",
        },
      ],
    });

    const { emit, events } = createEventCollector();
    const session = createTestSession({
      agent: {
        modelReference: { id: "anthropic/claude-opus-4.6" },
        system: "You are a test assistant.",
        tools: [{ description: "Search the web", name: "web_search", inputSchema: null }],
      },
    });
    const harness = createToolLoopHarness(
      createTestConfig("conversation", emit, { tools: new Map() }),
    );

    const result = await harness(session, { message: "Use web_search." });

    expect(events.filter((event) => event.type === "actions.requested")).toEqual([
      {
        type: "actions.requested",
        data: {
          actions: [
            {
              callId: toolCallId,
              input: { query: "eve release note current" },
              kind: "tool-call",
              toolName: "web_search",
            },
          ],
          sequence: 0,
          stepIndex: 0,
          turnId: "turn_0",
        },
      },
    ]);
    expect(events.filter((event) => event.type === "action.result")).toEqual([
      {
        type: "action.result",
        data: {
          result: {
            callId: toolCallId,
            kind: "tool-result",
            output: webSearchOutput,
            toolName: "web_search",
          },
          sequence: 0,
          stepIndex: 0,
          status: "completed",
          turnId: "turn_0",
        },
      },
    ]);
    const finalMessageIndex = events.findIndex(
      (event) => event.type === "message.completed" && event.data.finishReason !== "tool-calls",
    );
    expect(finalMessageIndex).toBeGreaterThanOrEqual(0);
    expect(
      events
        .slice(finalMessageIndex + 1)
        .filter((event) => event.type === "actions.requested" || event.type === "action.result"),
    ).toEqual([]);
    expect(result.next).toBeNull();
    expect(result.session.history.at(-1)?.role).toBe("assistant");
  });

  it("continues after provider-executed web_search follows assistant narration", async () => {
    const toolCallId = "parallel_search_narrated";
    const webSearchOutput = {
      search_id: "search-1",
      results: [
        { excerpts: ["Current result"], title: "Current result", url: "https://example.com" },
      ],
      usage: [{ count: 1, name: "sku_search" }],
    };
    setupMockAgent({
      content: [
        { text: "I will look that up.", type: "text" },
        {
          input: { objective: "Search the web." },
          toolCallId,
          toolName: "web_search",
          type: "tool-call",
        },
        {
          output: webSearchOutput,
          providerExecuted: true,
          toolCallId,
          toolName: "web_search",
          type: "tool-result",
        },
      ],
      finishReason: "stop",
      response: {
        messages: [
          {
            content: [
              { text: "I will look that up.", type: "text" },
              {
                input: { objective: "Search the web." },
                toolCallId,
                toolName: "web_search",
                type: "tool-call",
              },
              {
                output: { type: "json", value: webSearchOutput },
                toolCallId,
                toolName: "web_search",
                type: "tool-result",
              },
            ],
            role: "assistant",
          },
        ],
      },
      text: "I will look that up.",
      toolCalls: [
        {
          input: { objective: "Search the web." },
          toolCallId,
          toolName: "web_search",
          type: "tool-call",
        },
      ],
      toolResults: [
        {
          output: webSearchOutput,
          providerExecuted: true,
          toolCallId,
          toolName: "web_search",
          type: "tool-result",
        },
      ],
    });

    const harness = createToolLoopHarness(
      createTestConfig("conversation", undefined, { tools: new Map() }),
    );
    const result = await harness(
      createTestSession({
        agent: {
          modelReference: { id: "anthropic/claude-sonnet-5" },
          system: "You are a test assistant.",
          tools: [{ description: "Search the web", name: "web_search", inputSchema: null }],
        },
      }),
      { message: "Search the web." },
    );

    expect(typeof result.next).toBe("function");
    expect(result.session.history.slice(-2)).toEqual([
      {
        content: [
          { text: "I will look that up.", type: "text" },
          {
            input: { objective: "Search the web." },
            providerExecuted: false,
            toolCallId,
            toolName: "web_search",
            type: "tool-call",
          },
        ],
        role: "assistant",
      },
      {
        content: [
          {
            output: { type: "json", value: webSearchOutput },
            toolCallId,
            toolName: "web_search",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ]);
  });

  it("normalizes provider history before parking on an input request", async () => {
    const searchCallId = "parallel_search_before_question";
    const questionCallId = "question-after-search";
    const webSearchOutput = { results: [], searchId: "search-1" };
    const questionInput = {
      options: [{ id: "one", label: "One" }],
      prompt: "Choose one.",
    };
    setupMockAgent({
      content: [
        {
          input: { objective: "Search the web." },
          toolCallId: searchCallId,
          toolName: "web_search",
          type: "tool-call",
        },
        {
          output: webSearchOutput,
          providerExecuted: true,
          toolCallId: searchCallId,
          toolName: "web_search",
          type: "tool-result",
        },
        {
          input: questionInput,
          toolCallId: questionCallId,
          toolName: "ask_question",
          type: "tool-call",
        },
      ],
      finishReason: "tool-calls",
      response: {
        messages: [
          {
            content: [
              { text: "I looked that up and need a choice.", type: "text" },
              {
                input: { objective: "Search the web." },
                toolCallId: searchCallId,
                toolName: "web_search",
                type: "tool-call",
              },
              {
                output: { type: "json", value: webSearchOutput },
                toolCallId: searchCallId,
                toolName: "web_search",
                type: "tool-result",
              },
              {
                input: questionInput,
                toolCallId: questionCallId,
                toolName: "ask_question",
                type: "tool-call",
              },
            ],
            role: "assistant",
          },
        ],
      },
      text: "I looked that up and need a choice.",
      toolCalls: [
        {
          input: { objective: "Search the web." },
          toolCallId: searchCallId,
          toolName: "web_search",
          type: "tool-call",
        },
        {
          input: questionInput,
          toolCallId: questionCallId,
          toolName: "ask_question",
          type: "tool-call",
        },
      ],
      toolResults: [
        {
          output: webSearchOutput,
          providerExecuted: true,
          toolCallId: searchCallId,
          toolName: "web_search",
          type: "tool-result",
        },
      ],
    });

    const harness = createToolLoopHarness(
      createTestConfig("conversation", undefined, { tools: new Map() }),
    );
    const result = await harness(
      createTestSession({
        agent: {
          modelReference: { id: "anthropic/claude-sonnet-5" },
          system: "You are a test assistant.",
          tools: [
            { description: "Search the web", name: "web_search", inputSchema: null },
            {
              description: "Ask the user a question.",
              name: "ask_question",
              inputSchema: { type: "object" },
            },
          ],
        },
      }),
      { message: "Search, then ask me a question." },
    );

    const pendingResponseMessages = (
      result.session.state?.["eve.runtime.pendingInputBatch"] as
        | { responseMessages?: readonly ModelMessage[] }
        | undefined
    )?.responseMessages;

    expect(result.next).toBeNull();
    expect(pendingResponseMessages).toEqual([
      {
        content: [
          { text: "I looked that up and need a choice.", type: "text" },
          {
            input: { objective: "Search the web." },
            providerExecuted: false,
            toolCallId: searchCallId,
            toolName: "web_search",
            type: "tool-call",
          },
        ],
        role: "assistant",
      },
      {
        content: [
          {
            output: { type: "json", value: webSearchOutput },
            toolCallId: searchCallId,
            toolName: "web_search",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
      {
        content: [
          {
            input: questionInput,
            toolCallId: questionCallId,
            toolName: "ask_question",
            type: "tool-call",
          },
        ],
        role: "assistant",
      },
    ]);
  });

  it("continues after a provider-executed web_search returns without assistant text", async () => {
    const toolCallId = "parallel_search_1";
    setupMockAgent({
      content: [
        {
          output: { results: [], searchId: "search-1" },
          providerExecuted: true,
          toolCallId,
          toolName: "web_search",
          type: "tool-result",
        },
      ],
      finishReason: "stop",
      response: {
        messages: [
          {
            content: [
              {
                input: { objective: "Search the web." },
                providerExecuted: true,
                toolCallId,
                toolName: "web_search",
                type: "tool-call",
              },
              {
                output: { type: "json", value: { results: [], searchId: "search-1" } },
                toolCallId,
                toolName: "web_search",
                type: "tool-result",
              },
            ],
            role: "assistant",
          },
        ],
      },
      text: "",
      toolCalls: [],
      toolResults: [
        {
          output: { results: [], searchId: "search-1" },
          providerExecuted: true,
          toolCallId,
          toolName: "web_search",
          type: "tool-result",
        },
      ],
    });

    const harness = createToolLoopHarness(
      createTestConfig("conversation", undefined, { tools: new Map() }),
    );
    const result = await harness(
      createTestSession({
        agent: {
          modelReference: { id: "openai/gpt-5.5" },
          system: "You are a test assistant.",
          tools: [{ description: "Search the web", name: "web_search", inputSchema: null }],
        },
      }),
      { message: "Search the web." },
    );

    expect(typeof result.next).toBe("function");
    expect(result.session.history.at(-1)).toEqual({
      content: [
        {
          input: { objective: "Search the web." },
          providerExecuted: true,
          toolCallId,
          toolName: "web_search",
          type: "tool-call",
        },
        {
          output: { type: "json", value: { results: [], searchId: "search-1" } },
          toolCallId,
          toolName: "web_search",
          type: "tool-result",
        },
      ],
      role: "assistant",
    });
  });

  it("normalizes an unmarked provider call without assistant text", async () => {
    const toolCallId = "parallel_search_unmarked";
    setupMockAgent({
      content: [
        {
          output: { results: [], searchId: "search-1" },
          providerExecuted: true,
          toolCallId,
          toolName: "web_search",
          type: "tool-result",
        },
      ],
      finishReason: "stop",
      response: {
        messages: [
          {
            content: [
              {
                input: { objective: "Search the web." },
                toolCallId,
                toolName: "web_search",
                type: "tool-call",
              },
              {
                output: { type: "json", value: { results: [], searchId: "search-1" } },
                toolCallId,
                toolName: "web_search",
                type: "tool-result",
              },
            ],
            role: "assistant",
          },
        ],
      },
      text: "",
      toolCalls: [],
      toolResults: [
        {
          output: { results: [], searchId: "search-1" },
          providerExecuted: true,
          toolCallId,
          toolName: "web_search",
          type: "tool-result",
        },
      ],
    });

    const harness = createToolLoopHarness(
      createTestConfig("conversation", undefined, { tools: new Map() }),
    );
    const result = await harness(
      createTestSession({
        agent: {
          modelReference: { id: "openai/gpt-5.5" },
          system: "You are a test assistant.",
          tools: [{ description: "Search the web", name: "web_search", inputSchema: null }],
        },
      }),
      { message: "Search the web." },
    );

    expect(typeof result.next).toBe("function");
    expect(result.session.history.slice(-2)).toEqual([
      {
        content: [
          {
            input: { objective: "Search the web." },
            providerExecuted: false,
            toolCallId,
            toolName: "web_search",
            type: "tool-call",
          },
        ],
        role: "assistant",
      },
      {
        content: [
          {
            output: { type: "json", value: { results: [], searchId: "search-1" } },
            toolCallId,
            toolName: "web_search",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ]);
  });

  it("emits provider-executed web_search errors through normal failed action results", async () => {
    const toolCallId = "srvtoolu_error";
    setupMockAgent({
      content: [
        {
          input: { query: "eve release note current" },
          toolCallId,
          toolName: "web_search",
          type: "tool-call",
        },
        {
          error: new Error("Search failed"),
          input: { query: "eve release note current" },
          providerExecuted: true,
          toolCallId,
          toolName: "web_search",
          type: "tool-error",
        },
      ],
      finishReason: "stop",
      fullStreamParts: [
        {
          input: { query: "eve release note current" },
          providerExecuted: true,
          toolCallId,
          toolName: "web_search",
          type: "tool-call",
        },
        {
          error: new Error("Search failed"),
          input: { query: "eve release note current" },
          providerExecuted: true,
          toolCallId,
          toolName: "web_search",
          type: "tool-error",
        },
        { finishReason: "stop", type: "finish-step" },
      ],
      response: {
        messages: [
          {
            content: [
              {
                input: { query: "eve release note current" },
                toolCallId,
                toolName: "web_search",
                type: "tool-call",
              },
              {
                output: { type: "error-text", value: "Search failed" },
                toolCallId,
                toolName: "web_search",
                type: "tool-result",
              },
            ],
            role: "assistant",
          },
        ],
      },
      text: "",
      toolCalls: [
        {
          input: { query: "eve release note current" },
          toolCallId,
          toolName: "web_search",
          type: "tool-call",
        },
      ],
      toolResults: [],
    });

    const { emit, events } = createEventCollector();
    const session = createTestSession({
      agent: {
        modelReference: { id: "anthropic/claude-opus-4.6" },
        system: "You are a test assistant.",
        tools: [{ description: "Search the web", name: "web_search", inputSchema: null }],
      },
    });
    const harness = createToolLoopHarness(
      createTestConfig("conversation", emit, { tools: new Map() }),
    );

    const result = await harness(session, { message: "Use web_search." });

    expect(events.filter((event) => event.type === "action.result")).toEqual([
      {
        type: "action.result",
        data: {
          error: {
            code: "ACTION_RESULT_FAILED",
            message: "Search failed",
          },
          result: {
            callId: toolCallId,
            isError: true,
            kind: "tool-result",
            output: "Search failed",
            toolName: "web_search",
          },
          sequence: 0,
          stepIndex: 0,
          status: "failed",
          turnId: "turn_0",
        },
      },
    ]);
    expect(typeof result.next).toBe("function");
    expect(result.session.history.slice(-2).map((message) => message.role)).toEqual([
      "assistant",
      "tool",
    ]);
  });

  it("preserves AI-SDK StepResult getter properties when synthesizing the inline tool-result message", async () => {
    /*
     * AI SDK `StepResult` is a class with prototype getters for
     * `content`, `toolCalls`, `toolResults`, and `text`. The inline
     * approval-resume repair must read those getters explicitly; rebuilding
     * it through object spread would copy only own enumerable properties,
     * silently turning all four getter-backed fields into `undefined`.
     */
    class FakeStepResult {
      response = {
        messages: [{ content: "`/workspace`", role: "assistant" as const }],
      };
      finishReason = "stop" as const;
      get content(): unknown[] {
        return [];
      }
      get text(): string {
        return "`/workspace`";
      }
      get toolCalls(): unknown[] {
        return [];
      }
      get toolResults(): unknown[] {
        return [];
      }
      get usage(): unknown {
        return undefined;
      }
    }

    setupMockAgent({
      finishReason: "stop",
      fullStreamParts: [
        {
          output: { ok: true },
          toolCallId: "call-1",
          toolName: "bash",
          type: "tool-result",
        },
        { id: "text-1", text: "`/workspace`", type: "text-delta" },
        { finishReason: "stop", type: "finish-step" },
      ],
      response: {
        messages: [{ content: "`/workspace`", role: "assistant" }],
      },
      text: "`/workspace`",
      toolCalls: [],
      toolResults: [],
    });

    /*
     * Override the agent mock so `onStepFinish` receives a class
     * instance — matching the AI SDK runtime shape — instead of the
     * plain object produced by `setupMockAgent`. This is what makes
     * the getter trap reachable from the test.
     */
    vi.mocked(ToolLoopAgent).mockImplementation(function (
      this: Record<string, unknown>,
      settings: MockAgentSettings,
    ) {
      const { onStepFinish } = settings;
      this.stream = vi.fn().mockImplementation(async () => {
        const stepInstance = new FakeStepResult();
        const fullStream = createExplicitMockFullStream([
          {
            output: { ok: true },
            toolCallId: "call-1",
            toolName: "bash",
            type: "tool-result",
          },
          { id: "text-1", text: "`/workspace`", type: "text-delta" },
          { finishReason: "stop", type: "finish-step" },
        ]);
        if (onStepFinish) {
          void Promise.resolve().then(() => onStepFinish(stepInstance as unknown));
        }
        return { fullStream, steps: Promise.resolve([stepInstance]) };
      });
      this.generate = vi.fn().mockResolvedValue(new FakeStepResult());
      return this as unknown as ToolLoopAgent;
    } as unknown as MockAgentConstructor);

    const { emit } = createEventCollector();
    const session = createPendingBashApprovalSession();

    const harness = createToolLoopHarness(
      createTestConfig("conversation", emit, { tools: new Map() }),
    );
    const result = await harness(session, {
      inputResponses: [{ optionId: "approve", requestId: "approval-1" }],
    });

    expect(result.session.history.filter((msg) => msg.role === "tool")).toHaveLength(2);
    expect(result.session.history.map((msg) => msg.role)).toEqual([
      "assistant",
      "tool",
      "tool",
      "assistant",
    ]);
  });

  it("emits parallel tool calls incrementally and preserves stream result order", async () => {
    setupMockAgent({
      finishReason: "stop",
      fullStreamParts: [
        { id: "text-1", text: "I'll grab those now.", type: "text-delta" },
        {
          input: { city: "New York" },
          toolCallId: "call-1",
          toolName: "get_weather",
          type: "tool-call",
        },
        {
          input: { city: "Los Angeles" },
          toolCallId: "call-2",
          toolName: "get_weather",
          type: "tool-call",
        },
        {
          output: { condition: "Cloudy", temperature: "68 F" },
          toolCallId: "call-2",
          toolName: "get_weather",
          type: "tool-result",
        },
        {
          output: { condition: "Sunny", temperature: "72 F" },
          toolCallId: "call-1",
          toolName: "get_weather",
          type: "tool-result",
        },
        { id: "text-2", text: "New York is 72 F and Los Angeles is 68 F.", type: "text-delta" },
        { finishReason: "stop", type: "finish-step" },
      ],
      response: {
        messages: [
          {
            content: [
              { text: "I'll grab those now.", type: "text" },
              {
                input: { city: "New York" },
                toolCallId: "call-1",
                toolName: "get_weather",
                type: "tool-call",
              },
              {
                input: { city: "Los Angeles" },
                toolCallId: "call-2",
                toolName: "get_weather",
                type: "tool-call",
              },
            ],
            role: "assistant",
          },
          {
            content: [
              {
                output: { condition: "Sunny", temperature: "72 F" },
                toolCallId: "call-1",
                toolName: "get_weather",
                type: "tool-result",
              },
              {
                output: { condition: "Cloudy", temperature: "68 F" },
                toolCallId: "call-2",
                toolName: "get_weather",
                type: "tool-result",
              },
            ],
            role: "tool",
          },
          { content: "New York is 72 F and Los Angeles is 68 F.", role: "assistant" },
        ],
      },
      text: "New York is 72 F and Los Angeles is 68 F.",
      toolCalls: [
        {
          input: { city: "New York" },
          toolCallId: "call-1",
          toolName: "get_weather",
          type: "tool-call",
        },
        {
          input: { city: "Los Angeles" },
          toolCallId: "call-2",
          toolName: "get_weather",
          type: "tool-call",
        },
      ],
      toolResults: [
        {
          input: { city: "New York" },
          output: { condition: "Sunny", temperature: "72 F" },
          toolCallId: "call-1",
          toolName: "get_weather",
          type: "tool-result",
        },
        {
          input: { city: "Los Angeles" },
          output: { condition: "Cloudy", temperature: "68 F" },
          toolCallId: "call-2",
          toolName: "get_weather",
          type: "tool-result",
        },
      ],
    });

    const { emit, events } = createEventCollector();
    const session = createTestSession({
      agent: {
        modelReference: { id: "anthropic/claude-opus-4.6" },
        system: "You are a test assistant.",
        tools: [
          {
            description: "Get weather for one city",
            name: "get_weather",
            inputSchema: { type: "object" },
          },
        ],
      },
    });
    const runStep = createToolLoopHarness(
      createTestConfig("conversation", emit, {
        tools: new Map(),
      }),
    );

    await runStep(session, { message: "Get the weather for two cities" });

    expect(
      events
        .filter((event) => event.type === "actions.requested")
        .map((event) => event.data.actions.map((action) => action.callId)),
    ).toEqual([["call-1"], ["call-2"]]);

    expect(
      events
        .filter((event) => event.type === "action.result")
        .map((event) => event.data.result.callId),
    ).toEqual(["call-2", "call-1"]);
  });

  it("emits each tool call as it streams across multiple assistant groups", async () => {
    setupMockAgent({
      finishReason: "stop",
      response: {
        messages: [
          {
            content: [
              { text: "I'll check New York first.", type: "text" },
              {
                input: { city: "New York" },
                toolCallId: "call-1",
                toolName: "get_weather",
                type: "tool-call",
              },
            ],
            role: "assistant",
          },
          {
            content: [
              {
                output: { condition: "Sunny", temperature: "72 F" },
                toolCallId: "call-1",
                toolName: "get_weather",
                type: "tool-result",
              },
            ],
            role: "tool",
          },
          {
            content: [
              { text: "Now I'll check Los Angeles.", type: "text" },
              {
                input: { city: "Los Angeles" },
                toolCallId: "call-2",
                toolName: "get_weather",
                type: "tool-call",
              },
            ],
            role: "assistant",
          },
          {
            content: [
              {
                output: { condition: "Cloudy", temperature: "68 F" },
                toolCallId: "call-2",
                toolName: "get_weather",
                type: "tool-result",
              },
            ],
            role: "tool",
          },
          { content: "New York is 72 F and Los Angeles is 68 F.", role: "assistant" },
        ],
      },
      text: "New York is 72 F and Los Angeles is 68 F.",
      toolCalls: [
        {
          input: { city: "New York" },
          toolCallId: "call-1",
          toolName: "get_weather",
          type: "tool-call",
        },
        {
          input: { city: "Los Angeles" },
          toolCallId: "call-2",
          toolName: "get_weather",
          type: "tool-call",
        },
      ],
      toolResults: [
        {
          input: { city: "New York" },
          output: { condition: "Sunny", temperature: "72 F" },
          toolCallId: "call-1",
          toolName: "get_weather",
          type: "tool-result",
        },
        {
          input: { city: "Los Angeles" },
          output: { condition: "Cloudy", temperature: "68 F" },
          toolCallId: "call-2",
          toolName: "get_weather",
          type: "tool-result",
        },
      ],
    });

    const { emit, events } = createEventCollector();
    const session = createTestSession({
      agent: {
        modelReference: { id: "anthropic/claude-opus-4.6" },
        system: "You are a test assistant.",
        tools: [
          {
            description: "Get weather for one city",
            name: "get_weather",
            inputSchema: { type: "object" },
          },
        ],
      },
    });
    const runStep = createToolLoopHarness(
      createTestConfig("conversation", emit, {
        tools: new Map(),
      }),
    );

    await runStep(session, { message: "Check two cities in sequence" });

    expect(getCompatibilityEventTypes(events)).toEqual([
      "session.started",
      "turn.started",
      "message.received",
      "step.started",
      "message.completed",
      "actions.requested",
      "action.result",
      "message.completed",
      "actions.requested",
      "action.result",
      "message.completed",
      "step.completed",
      "turn.completed",
      "session.waiting",
    ]);

    expect(
      events
        .filter((event) => event.type === "actions.requested")
        .map((event) => event.data.actions.map((action) => action.callId)),
    ).toEqual([["call-1"], ["call-2"]]);
  });

  it("emits input.requested for tool approval requests and parks without persisting unresolved messages", async () => {
    setupMockAgent({
      content: [
        {
          approvalId: "approval-1",
          toolCall: {
            input: { command: "rm -rf /tmp/demo" },
            toolCallId: "call-1",
            toolName: "bash",
          },
          type: "tool-approval-request",
        },
      ],
      finishReason: "tool-calls",
      response: {
        messages: [
          {
            content: [
              { text: "Need approval first.", type: "text" },
              {
                input: { command: "rm -rf /tmp/demo" },
                toolCallId: "call-1",
                toolName: "bash",
                type: "tool-call",
              },
              {
                approvalId: "approval-1",
                toolCallId: "call-1",
                type: "tool-approval-request",
              },
            ],
            role: "assistant",
          },
        ],
      },
      text: "",
      toolCalls: [
        {
          input: { command: "rm -rf /tmp/demo" },
          toolCallId: "call-1",
          toolName: "bash",
          type: "tool-call",
        },
      ],
      toolResults: [],
    });

    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(
      createTestConfig("conversation", emit, {
        tools: new Map([
          [
            "bash",
            {
              description: "Run shell commands",
              execute: vi.fn().mockResolvedValue("ok"),
              inputSchema: jsonSchema({ type: "object" }),
              name: "bash",
            },
          ],
        ]),
      }),
    );
    const session = createTestSession({
      agent: {
        modelReference: { id: "test-model" },
        system: "You are a test assistant.",
        tools: [
          { description: "Run shell commands", name: "bash", inputSchema: { type: "object" } },
        ],
      },
    });

    const result = await runStep(session, { message: "Delete the temp directory." });

    expect(result.next).toBeNull();
    expect(result.session.history).toEqual([
      { content: "Delete the temp directory.", role: "user" },
    ]);
    expect(getCompatibilityEventTypes(events)).toEqual([
      "session.started",
      "turn.started",
      "message.received",
      "step.started",
      "message.completed",
      "actions.requested",
      "step.completed",
      "input.requested",
      "turn.completed",
      "session.waiting",
    ]);
    expect(events.find((event) => event.type === "actions.requested")).toEqual({
      data: {
        actions: [
          {
            callId: "call-1",
            input: { command: "rm -rf /tmp/demo" },
            kind: "tool-call",
            toolName: "bash",
          },
        ],
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_0",
      },
      type: "actions.requested",
    });
    expect(events.find((event) => event.type === "input.requested")).toEqual({
      data: {
        requests: [
          {
            action: {
              callId: "call-1",
              input: { command: "rm -rf /tmp/demo" },
              kind: "tool-call",
              toolName: "bash",
            },
            allowFreeform: false,
            display: "confirmation",
            options: [
              { id: "approve", label: "Yes" },
              { id: "deny", label: "No" },
            ],
            prompt: "Approve tool call: bash",
            requestId: "approval-1",
          },
        ],
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_0",
      },
      type: "input.requested",
    });
  });

  it.each([
    { approved: true, label: "approval", reason: undefined },
    { approved: false, label: "denial", reason: "Blocked by policy." },
  ])("does not park on automatic $label records", async ({ approved, reason }) => {
    const toolCall = {
      input: { command: "rm -rf /tmp/demo" },
      toolCallId: "call-1",
      toolName: "bash",
      type: "tool-call" as const,
    };
    const approvalRequest = {
      approvalId: "approval-1",
      isAutomatic: true,
      toolCall,
      type: "tool-approval-request" as const,
    };
    const approvalResponse = {
      approvalId: "approval-1",
      approved,
      reason,
      toolCall,
      type: "tool-approval-response" as const,
    };
    const toolResult = {
      input: toolCall.input,
      output: { ok: true },
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      type: "tool-result" as const,
    };
    const responseMessages = [
      {
        content: [
          toolCall,
          {
            approvalId: approvalRequest.approvalId,
            isAutomatic: true,
            toolCallId: toolCall.toolCallId,
            type: "tool-approval-request" as const,
          },
        ],
        role: "assistant" as const,
      },
      {
        content: [
          {
            approvalId: approvalResponse.approvalId,
            approved,
            reason,
            type: "tool-approval-response" as const,
          },
          {
            output: approved
              ? { type: "json" as const, value: toolResult.output }
              : { type: "execution-denied" as const, reason },
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            type: "tool-result" as const,
          },
        ],
        role: "tool" as const,
      },
    ];

    setupMockAgent({
      content: [toolCall, approvalRequest, approvalResponse, ...(approved ? [toolResult] : [])],
      finishReason: "tool-calls",
      response: { messages: responseMessages },
      text: "",
      toolCalls: [toolCall],
      toolResults: approved ? [toolResult] : [],
    });

    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(
      createTestConfig("conversation", emit, {
        tools: new Map([
          [
            "bash",
            {
              description: "Run shell commands",
              execute: vi.fn().mockResolvedValue({ ok: true }),
              inputSchema: jsonSchema({ type: "object" }),
              name: "bash",
            },
          ],
        ]),
      }),
    );
    const session = createTestSession({
      agent: {
        modelReference: { id: "test-model" },
        system: "You are a test assistant.",
        tools: [
          { description: "Run shell commands", name: "bash", inputSchema: { type: "object" } },
        ],
      },
    });

    const result = await runStep(session, { message: "Delete the temp directory." });

    expect(typeof result.next).toBe("function");
    expect(result.session.history).toEqual([
      { content: "Delete the temp directory.", role: "user" },
      ...responseMessages,
    ]);
    expect(events.filter((event) => event.type === "input.requested")).toEqual([]);
    expect(events.filter((event) => event.type === "actions.requested")).toHaveLength(1);
    expect(events.filter((event) => event.type === "action.result")).toHaveLength(1);
  });

  it("queues a follow-up user message until the pending tool approval resolves", async () => {
    const generateCalls: unknown[] = [];
    const agentResults = [
      {
        finishReason: "stop",
        response: {
          messages: [{ content: "Okay, I will not run that command.", role: "assistant" }],
        },
        text: "Okay, I will not run that command.",
        toolCalls: [],
        toolResults: [],
      },
      {
        finishReason: "stop",
        response: { messages: [{ content: "Hello!", role: "assistant" }] },
        text: "Hello!",
        toolCalls: [],
        toolResults: [],
      },
    ] satisfies Record<string, unknown>[];
    let instanceIndex = 0;

    vi.mocked(ToolLoopAgent).mockImplementation(function (
      this: MockAgentInstance,
      settings: MockAgentSettings,
    ) {
      const result = agentResults[instanceIndex];
      instanceIndex += 1;
      const { onStepFinish, prepareStep } = settings;
      this.generate = vi.fn().mockImplementation(async (input: { messages: unknown[] }) => {
        if (prepareStep) {
          await prepareStep({
            messages: input.messages,
            steps: [],
            stepNumber: 0,
            model: {},
            context: undefined,
          });
        }
        generateCalls.push(input.messages);
        if (onStepFinish) await onStepFinish(result);
        return result;
      });
      return this;
    } as MockAgentConstructor);

    const session = setPendingInputBatch({
      requests: [
        {
          action: {
            callId: "call-1",
            input: { command: "rm -rf /tmp/demo" },
            kind: "tool-call",
            toolName: "bash",
          },
          allowFreeform: false,
          display: "confirmation",
          options: [
            { id: "approve", label: "Yes" },
            { id: "deny", label: "No" },
          ],
          prompt: "Approve tool call: bash",
          requestId: "approval-1",
        },
      ],
      responseMessages: [
        {
          content: [
            {
              input: { command: "rm -rf /tmp/demo" },
              toolCallId: "call-1",
              toolName: "bash",
              type: "tool-call",
            },
            {
              approvalId: "approval-1",
              toolCallId: "call-1",
              type: "tool-approval-request",
            },
          ],
          role: "assistant",
        },
      ],
      session: createTestSession({
        agent: {
          modelReference: { id: "test-model" },
          system: "You are a test assistant.",
          tools: [
            { description: "Run shell commands", name: "bash", inputSchema: { type: "object" } },
          ],
        },
      }),
    });
    const config = createTestConfig("conversation", undefined, {
      tools: new Map([
        [
          "bash",
          {
            description: "Run shell commands",
            execute: vi.fn().mockResolvedValue("ok"),
            inputSchema: jsonSchema({ type: "object" }),
            name: "bash",
          },
        ],
      ]),
    });

    const firstResult = await createToolLoopHarness(config)(session, {
      message: "Hi instead.",
    });

    expect(firstResult.next).toBeNull();
    expect(generateCalls).toEqual([]);
    expect(hasDeferredStepInput(firstResult.session)).toBe(true);

    const deniedResult = await createToolLoopHarness(config)(firstResult.session, {
      inputResponses: [{ requestId: "approval-1", optionId: "deny" }],
    });

    expect(typeof deniedResult.next).toBe("function");
    expect(generateCalls[0]).toEqual([
      {
        content: [
          {
            input: { command: "rm -rf /tmp/demo" },
            toolCallId: "call-1",
            toolName: "bash",
            type: "tool-call",
          },
          {
            approvalId: "approval-1",
            toolCallId: "call-1",
            type: "tool-approval-request",
          },
        ],
        role: "assistant",
      },
      {
        content: [
          {
            approvalId: "approval-1",
            approved: false,
            reason: "Tool execution was denied.",
            type: "tool-approval-response",
          },
          {
            output: {
              type: "execution-denied",
              reason: "Tool execution was denied.",
            },
            toolCallId: "call-1",
            toolName: "bash",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ]);

    const secondResult = await createToolLoopHarness(config)(deniedResult.session);

    expect(secondResult.next).toBeNull();
    expect((generateCalls[1] as { role: string; content: unknown }[]).at(-1)).toEqual({
      content: "Hi instead.",
      role: "user",
    });
    expect(secondResult.session.history.at(-2)).toEqual({
      content: "Hi instead.",
      role: "user",
    });
    expect(secondResult.session.history.at(-1)).toEqual({
      content: "Hello!",
      role: "assistant",
    });
  });

  it("consumes text approval shortcuts without appending them as user messages", async () => {
    const generateCalls: unknown[] = [];

    vi.mocked(ToolLoopAgent).mockImplementation(function (
      this: Record<string, unknown>,
      settings: MockAgentSettings,
    ) {
      const { onStepFinish, prepareStep } = settings;
      this.generate = vi.fn().mockImplementation(async (input: { messages: unknown[] }) => {
        if (prepareStep) {
          await prepareStep({
            messages: input.messages,
            steps: [],
            stepNumber: 0,
            model: {},
            context: undefined,
          });
        }
        generateCalls.push(input.messages);
        const result = {
          finishReason: "stop",
          response: { messages: [{ content: "Approved.", role: "assistant" }] },
          text: "Approved.",
          toolCalls: [],
          toolResults: [],
        };
        if (onStepFinish) await onStepFinish(result);
        return result;
      });
      return this as unknown as ToolLoopAgent;
    } as unknown as ConstructorParameters<typeof ToolLoopAgent> extends [infer S]
      ? (settings: S) => ToolLoopAgent
      : never);

    const session = setPendingInputBatch({
      requests: [
        {
          action: {
            callId: "call-1",
            input: { note: "text approval" },
            kind: "tool-call",
            toolName: "guarded_echo",
          },
          allowFreeform: false,
          display: "confirmation",
          options: [
            { id: "approve", label: "Yes" },
            { id: "deny", label: "No" },
          ],
          prompt: "Approve tool call: guarded_echo",
          requestId: "approval-1",
        },
      ],
      responseMessages: [
        {
          content: [
            {
              input: { note: "text approval" },
              toolCallId: "call-1",
              toolName: "guarded_echo",
              type: "tool-call",
            },
            {
              approvalId: "approval-1",
              toolCallId: "call-1",
              type: "tool-approval-request",
            },
          ],
          role: "assistant",
        },
      ],
      session: createTestSession({
        agent: {
          modelReference: { id: "test-model" },
          system: "You are a test assistant.",
          tools: [
            {
              description: "Echo a note",
              name: "guarded_echo",
              inputSchema: { type: "object" },
            },
          ],
        },
      }),
    });

    const config = createTestConfig("conversation", undefined, {
      tools: new Map([
        [
          "guarded_echo",
          {
            description: "Echo a note",
            execute: vi.fn().mockResolvedValue("ok"),
            inputSchema: jsonSchema({ type: "object" }),
            name: "guarded_echo",
          },
        ],
      ]),
    });

    await createToolLoopHarness(config)(session, { message: "approve" });

    expect(generateCalls[0]).toEqual([
      {
        content: [
          {
            input: { note: "text approval" },
            toolCallId: "call-1",
            toolName: "guarded_echo",
            type: "tool-call",
          },
          {
            approvalId: "approval-1",
            toolCallId: "call-1",
            type: "tool-approval-request",
          },
        ],
        role: "assistant",
      },
      {
        content: [
          {
            approvalId: "approval-1",
            approved: true,
            reason: undefined,
            type: "tool-approval-response",
          },
        ],
        role: "tool",
      },
    ]);
  });

  it("deferred message lands as last non-system message after explicit approval denial", async () => {
    // Step 1: pending approval + user sends a follow-up message. The approval
    // remains pending and the message is deferred. Step 2: the user denies the
    // approval. Step 3: the deferred message is consumed and appears as the
    // last message the model sees.
    const generateCalls: Array<Array<{ role: string; content: unknown }>> = [];
    const agentResults = [
      {
        finishReason: "stop",
        response: {
          messages: [{ content: "I will not run that command.", role: "assistant" }],
        },
        text: "I will not run that command.",
        toolCalls: [],
        toolResults: [],
      },
      {
        finishReason: "stop",
        response: { messages: [{ content: "Sure, here you go.", role: "assistant" }] },
        text: "Sure, here you go.",
        toolCalls: [],
        toolResults: [],
      },
    ] satisfies Record<string, unknown>[];
    let instanceIndex = 0;

    vi.mocked(ToolLoopAgent).mockImplementation(function (
      this: Record<string, unknown>,
      settings: MockAgentSettings,
    ) {
      const result = agentResults[instanceIndex];
      instanceIndex += 1;
      const { onStepFinish, prepareStep } = settings;
      this.generate = vi.fn().mockImplementation(async (input: { messages: unknown[] }) => {
        if (prepareStep) {
          await prepareStep({
            messages: input.messages,
            steps: [],
            stepNumber: 0,
            model: {},
            context: undefined,
          });
        }
        generateCalls.push(input.messages as Array<{ role: string; content: unknown }>);
        if (onStepFinish) await onStepFinish(result);
        return result;
      });
      return this as unknown as ToolLoopAgent;
    } as unknown as ConstructorParameters<typeof ToolLoopAgent> extends [infer S]
      ? (settings: S) => ToolLoopAgent
      : never);

    const session = setPendingInputBatch({
      requests: [
        {
          action: {
            callId: "call-1",
            input: { command: "deploy --force" },
            kind: "tool-call",
            toolName: "bash",
          },
          allowFreeform: false,
          display: "confirmation",
          options: [
            { id: "approve", label: "Yes" },
            { id: "deny", label: "No" },
          ],
          prompt: "Approve tool call: bash",
          requestId: "approval-1",
        },
      ],
      responseMessages: [
        {
          content: [
            {
              input: { command: "deploy --force" },
              toolCallId: "call-1",
              toolName: "bash",
              type: "tool-call",
            },
            {
              approvalId: "approval-1",
              toolCallId: "call-1",
              type: "tool-approval-request",
            },
          ],
          role: "assistant",
        },
      ],
      session: createTestSession({
        agent: {
          modelReference: { id: "test-model" },
          system: "You are a test assistant.",
          tools: [
            { description: "Run shell commands", name: "bash", inputSchema: { type: "object" } },
          ],
        },
      }),
    });

    const config = createTestConfig("conversation", undefined, {
      tools: new Map([
        [
          "bash",
          {
            description: "Run shell commands",
            execute: vi.fn().mockResolvedValue("ok"),
            inputSchema: jsonSchema({ type: "object" }),
            name: "bash",
          },
        ],
      ]),
    });

    // Step 1: user sends "Do something else" while approval is pending.
    // Approval remains pending; message is deferred.
    const firstResult = await createToolLoopHarness(config)(session, {
      message: "Do something else",
    });
    expect(firstResult.next).toBeNull();
    expect(generateCalls).toEqual([]);

    // Step 2: user denies the approval; the deferred message is NOT in this call.
    const deniedResult = await createToolLoopHarness(config)(firstResult.session, {
      inputResponses: [{ requestId: "approval-1", optionId: "deny" }],
    });
    expect(typeof deniedResult.next).toBe("function");
    const step2Last = generateCalls[0]?.at(-1);
    expect(step2Last?.role).toBe("tool");

    // Step 3: harness consumes the deferred message.
    const secondResult = await createToolLoopHarness(config)(deniedResult.session);
    expect(secondResult.next).toBeNull();

    // The deferred user message is the last message the model sees.
    const step3Last = generateCalls[1]?.at(-1);
    expect(step3Last).toEqual({ content: "Do something else", role: "user" });

    // History reflects the full conversation.
    expect(secondResult.session.history.at(-1)).toEqual({
      content: "Sure, here you go.",
      role: "assistant",
    });
  });

  it("emits input.requested for ask_question and does not emit actions.requested", async () => {
    setupMockAgent({
      content: [],
      finishReason: "tool-calls",
      response: {
        messages: [
          {
            content: [
              { text: "I need a choice.", type: "text" },
              {
                input: {
                  options: [{ id: "one", label: "One" }],
                  prompt: "Choose one.",
                },
                toolCallId: "question-1",
                toolName: "ask_question",
                type: "tool-call",
              },
            ],
            role: "assistant",
          },
        ],
      },
      text: "",
      toolCalls: [
        {
          input: {
            options: [{ id: "one", label: "One" }],
            prompt: "Choose one.",
          },
          toolCallId: "question-1",
          toolName: "ask_question",
          type: "tool-call",
        },
      ],
      toolResults: [],
    });

    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(createTestConfig("conversation", emit));
    const session = createTestSession({
      agent: {
        modelReference: { id: "test-model" },
        system: "You are a test assistant.",
        tools: [
          {
            description: "Ask the user a question.",
            name: "ask_question",
            inputSchema: { type: "object" },
          },
        ],
      },
    });

    const result = await runStep(session, { message: "Choose for me." });

    expect(result.next).toBeNull();
    expect(events.some((event) => event.type === "actions.requested")).toBe(false);
    expect(events.find((event) => event.type === "input.requested")).toEqual({
      data: {
        requests: [
          {
            action: {
              callId: "question-1",
              input: {
                options: [{ id: "one", label: "One" }],
                prompt: "Choose one.",
              },
              kind: "tool-call",
              toolName: "ask_question",
            },
            display: "select",
            options: [{ id: "one", label: "One" }],
            prompt: "Choose one.",
            requestId: "question-1",
          },
        ],
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_0",
      },
      type: "input.requested",
    });
  });

  it("emits compaction.requested and compaction.completed when compaction triggers", async () => {
    vi.mocked(shouldCompact).mockReturnValue(true);
    vi.mocked(compactMessages).mockResolvedValue([
      { content: "Summary of our conversation so far:", role: "user" },
      { content: "summary", role: "assistant" },
      { content: "recent message", role: "user" },
    ]);

    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "Got it.", role: "assistant" }] },
      text: "Got it.",
      toolCalls: [],
      toolResults: [],
    });

    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(
      createTestConfig("conversation", emit, {
        resolveModel: vi
          .fn()
          .mockResolvedValue({ modelId: "gpt-4", provider: "openai" } as LanguageModel),
      }),
    );
    const session = createTestSession({
      history: [
        { content: "old message", role: "user" },
        { content: "old reply", role: "assistant" },
      ],
    });

    await runStep(session, { message: "Hi" });

    expect(getCompatibilityEventTypes(events)).toEqual([
      "session.started",
      "turn.started",
      "message.received",
      "compaction.requested",
      "compaction.completed",
      "step.started",
      "message.completed",
      "step.completed",
      "turn.completed",
      "session.waiting",
    ]);

    expect(events.find((e) => e.type === "compaction.requested")?.data).toEqual({
      modelId: "openai/gpt-4",
      sequence: 0,
      sessionId: "test-session",
      turnId: "turn_0",
      usageInputTokens: 5000,
    });

    expect(events.find((e) => e.type === "compaction.completed")?.data).toEqual({
      modelId: "openai/gpt-4",
      sequence: 0,
      sessionId: "test-session",
      turnId: "turn_0",
    });
  });

  it("uses the authored compaction model when one is configured", async () => {
    vi.mocked(shouldCompact).mockReturnValue(true);
    vi.mocked(compactMessages).mockResolvedValue([
      { content: "Summary of our conversation so far:", role: "user" },
      { content: "summary", role: "assistant" },
      { content: "recent message", role: "user" },
    ]);

    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "Got it.", role: "assistant" }] },
      text: "Got it.",
      toolCalls: [],
      toolResults: [],
    });

    const config: ToolLoopHarnessConfig = {
      ...createTestConfig("conversation"),
      resolveModel: vi.fn().mockImplementation(
        async (reference) =>
          ({
            modelId: reference.id,
            provider: "openai",
          }) as LanguageModel,
      ),
    };

    const runStep = createToolLoopHarness(config);
    const session = createTestSession({
      agent: {
        compactionModelReference: { id: "summary-model" },
        modelReference: { id: "main-model" },
        system: "You are a test assistant.",
        tools: [{ description: "Adds numbers", name: "add", inputSchema: { type: "object" } }],
      },
      history: [
        { content: "old message", role: "user" },
        { content: "old reply", role: "assistant" },
      ],
    });

    await runStep(session, { message: "Hi" });

    const call = vi.mocked(compactMessages).mock.calls[0];
    expect(call?.[0]).toEqual([
      { content: "old message", role: "user" },
      { content: "old reply", role: "assistant" },
      { content: "Hi", role: "user" },
    ]);
    expect(call?.[1]).toMatchObject({
      modelId: "summary-model",
      provider: "openai",
    });
    expect(call?.[2]).toEqual(
      expect.objectContaining({
        recentWindowSize: 10,
        threshold: 100_000,
      }),
    );
    expect(call?.[3]).toBeUndefined();
  });

  it("emits reasoning.completed when reasoning text is available", async () => {
    vi.mocked(shouldCompact).mockReturnValue(false);

    setupMockAgent({
      finishReason: "stop",
      reasoningText: "Need to check the known constraints first.",
      response: {
        messages: [
          {
            content: [
              { text: "Need to check the known constraints first.", type: "reasoning" },
              { text: "Answer ready.", type: "text" },
            ],
            role: "assistant",
          },
        ],
      },
      text: "Answer ready.",
      toolCalls: [],
      toolResults: [],
    });

    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(createTestConfig("conversation", emit));

    await runStep(createTestSession(), { message: "Hi" });

    expect(events.map((event) => event.type)).toEqual([
      "session.started",
      "turn.started",
      "message.received",
      "step.started",
      "reasoning.appended",
      "reasoning.completed",
      "message.appended",
      "message.completed",
      "step.completed",
      "turn.completed",
      "session.waiting",
    ]);
    expect(events.find((event) => event.type === "reasoning.appended")?.data).toEqual({
      reasoningDelta: "Need to check the known constraints first.",
      reasoningSoFar: "Need to check the known constraints first.",
      sequence: 0,
      stepIndex: 0,
      turnId: "turn_0",
    });
    expect(events.find((event) => event.type === "reasoning.completed")?.data).toEqual({
      reasoning: "Need to check the known constraints first.",
      sequence: 0,
      stepIndex: 0,
      turnId: "turn_0",
    });
    expect(events.find((event) => event.type === "message.appended")?.data).toEqual({
      messageDelta: "Answer ready.",
      messageSoFar: "Answer ready.",
      sequence: 0,
      stepIndex: 0,
      turnId: "turn_0",
    });
  });

  it("emits message.appended deltas while preserving message.completed for completed-only consumers", async () => {
    vi.mocked(shouldCompact).mockReturnValue(false);

    setupMockAgent({
      finishReason: "stop",
      fullStreamParts: [
        { id: "text-1", text: "Hello", type: "text-delta" },
        { id: "text-1", text: " there.", type: "text-delta" },
        { finishReason: "stop", type: "finish-step" },
      ],
      response: { messages: [{ content: "Hello there.", role: "assistant" }] },
      text: "Hello there.",
      toolCalls: [],
      toolResults: [],
    });

    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(createTestConfig("conversation", emit));

    await runStep(createTestSession(), { message: "Hi" });

    expect(events.map((event) => event.type)).toEqual([
      "session.started",
      "turn.started",
      "message.received",
      "step.started",
      "message.appended",
      "message.appended",
      "message.completed",
      "step.completed",
      "turn.completed",
      "session.waiting",
    ]);
    expect(
      events.filter((event) => event.type === "message.appended").map((event) => event.data),
    ).toEqual([
      {
        messageDelta: "Hello",
        messageSoFar: "Hello",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_0",
      },
      {
        messageDelta: " there.",
        messageSoFar: "Hello there.",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_0",
      },
    ]);
    expect(events.find((event) => event.type === "message.completed")?.data).toEqual({
      finishReason: "stop",
      message: "Hello there.",
      sequence: 0,
      stepIndex: 0,
      turnId: "turn_0",
    });
    expect(getCompatibilityEventTypes(events)).toEqual([
      "session.started",
      "turn.started",
      "message.received",
      "step.started",
      "message.completed",
      "step.completed",
      "turn.completed",
      "session.waiting",
    ]);
  });

  it("stores the exact input token count from the completed model step", async () => {
    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "Hello!", role: "assistant" }] },
      text: "Hello!",
      toolCalls: [],
      toolResults: [],
      usage: {
        inputTokens: 321,
      },
    });

    const config = createTestConfig("conversation");
    const runStep = createToolLoopHarness(config);

    const result = await runStep(createTestSession(), { message: "Hi" });

    expect(result.session.compaction).toMatchObject({
      lastKnownInputTokens: 321,
      lastKnownPromptMessageCount: 1,
    });
  });

  it("invokes onCompaction callback after compaction", async () => {
    vi.mocked(shouldCompact).mockReturnValue(true);
    vi.mocked(compactMessages).mockResolvedValue([
      { content: "Summary of our conversation so far:", role: "user" },
      { content: "summary", role: "assistant" },
    ]);

    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "Resuming.", role: "assistant" }] },
      text: "Resuming.",
      toolCalls: [],
      toolResults: [],
    });

    const onCompaction = vi
      .fn()
      .mockReturnValue([{ content: "[State preserved]", role: "user" as const }]);

    const runStep = createToolLoopHarness(
      createTestConfig("conversation", undefined, { onCompaction }),
    );
    const session = createTestSession({
      history: [{ content: "old", role: "user" }],
    });

    const result = await runStep(session, { message: "Continue" });

    expect(onCompaction).toHaveBeenCalledTimes(1);
    expect(result.session.history).toEqual([
      { content: "Summary of our conversation so far:", role: "user" },
      { content: "summary", role: "assistant" },
      { content: "[State preserved]", role: "user" },
      { content: "Resuming.", role: "assistant" },
    ]);
  });

  it("compaction appends synthetic user message when recent window trails with assistant", async () => {
    // Step 1: tool call → harness continues (next === runStep).
    setupMockAgent({
      content: [{ type: "tool-call", toolCallId: "call-1", toolName: "add", args: {} }],
      finishReason: "tool-calls",
      response: {
        messages: [
          {
            content: [{ type: "tool-call", toolCallId: "call-1", toolName: "add", args: {} }],
            role: "assistant",
          },
          {
            content: [{ type: "tool-result", toolCallId: "call-1", toolName: "add", output: "42" }],
            role: "tool",
          },
        ],
      },
      text: "",
      toolCalls: [{ toolCallId: "call-1", toolName: "add", input: {} }],
      toolResults: [{ toolCallId: "call-1", toolName: "add", output: "42" }],
    });

    const step1Harness = createToolLoopHarness(createTestConfig("conversation"));
    const result1 = await step1Harness(createTestSession(), { message: "add stuff" });
    expect(result1.next).toBe(step1Harness);
    expect(result1.session.history.at(-1)).toMatchObject({ role: "tool" });

    // Step 2: continuation — model responds with text, turn ends.
    // History now trails with assistant.
    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "The answer is 42.", role: "assistant" }] },
      text: "The answer is 42.",
      toolCalls: [],
      toolResults: [],
    });

    const step2Harness = createToolLoopHarness(createTestConfig("conversation"));
    const result2 = await step2Harness(result1.session);
    expect(result2.next).toBeNull();
    expect(result2.session.history.at(-1)).toMatchObject({
      content: "The answer is 42.",
      role: "assistant",
    });

    // Step 3: new turn with compaction. The mock simulates the
    // guarded output from the real compactMessages: trailing
    // assistant gets a synthetic user("Continue.") appended.
    vi.mocked(shouldCompact).mockReturnValue(true);
    vi.mocked(compactMessages).mockResolvedValue([
      { content: "Summary of our conversation so far:", role: "user" },
      { content: "summary", role: "assistant" },
      { content: "The answer is 42.", role: "assistant" },
      { content: "Continue.", role: "user" },
    ]);

    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "Sure.", role: "assistant" }] },
      text: "Sure.",
      toolCalls: [],
      toolResults: [],
    });

    const step3Harness = createToolLoopHarness(createTestConfig("conversation"));
    await step3Harness(result2.session, {});

    // Verify the model received messages ending with the synthetic
    // user message, not the trailing assistant.
    const instance = vi.mocked(ToolLoopAgent).mock.results.at(-1)?.value as {
      generate: ReturnType<typeof vi.fn>;
    };
    const modelMessages = instance.generate.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(modelMessages.messages.at(-1)).toEqual({ content: "Continue.", role: "user" });
  });

  it("does not call onCompaction when compaction does not trigger", async () => {
    vi.mocked(shouldCompact).mockReturnValue(false);

    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "Hello!", role: "assistant" }] },
      text: "Hello!",
      toolCalls: [],
      toolResults: [],
    });

    const onCompaction = vi.fn();
    const runStep = createToolLoopHarness(
      createTestConfig("conversation", undefined, { onCompaction }),
    );
    await runStep(createTestSession(), { message: "Hi" });

    expect(onCompaction).not.toHaveBeenCalled();
  });

  describe("prompt caching", () => {
    function setupStopResult(): void {
      setupMockAgent({
        finishReason: "stop",
        response: { messages: [{ content: "ok", role: "assistant" }] },
        text: "ok",
        toolCalls: [],
        toolResults: [],
      });
    }

    it("preserves the gateway-cached prompt prefix across tool steps and user turns", async () => {
      type CapturedModelCall = {
        instructions: unknown;
        messages: Array<{ content: unknown; role: string }>;
        providerOptions: unknown;
        tools: Array<{
          description: unknown;
          inputSchema: unknown;
          name: string;
          providerOptions: unknown;
        }>;
      };
      type PromptAgentSettings = MockAgentSettings & {
        instructions?: unknown;
        tools?: Record<
          string,
          { description?: unknown; inputSchema?: unknown; providerOptions?: unknown }
        >;
      };

      async function captureModelCall(index: number): Promise<CapturedModelCall> {
        const settings = vi.mocked(ToolLoopAgent).mock.calls[index]?.[0] as
          | PromptAgentSettings
          | undefined;
        const instance = vi.mocked(ToolLoopAgent).mock.results[index]?.value as
          | { generate: ReturnType<typeof vi.fn> }
          | undefined;
        const call = instance?.generate.mock.calls[0]?.[0] as
          | { messages: CapturedModelCall["messages"] }
          | undefined;
        if (settings === undefined || call === undefined) {
          throw new Error(`Missing captured model call ${String(index)}.`);
        }

        const prepareStep = getPrepareStep<
          CapturedModelCall["messages"],
          { messages?: CapturedModelCall["messages"]; providerOptions?: unknown }
        >(settings.prepareStep);
        const prepared = await prepareStep({
          context: undefined,
          messages: call.messages,
          model: {},
          stepNumber: 0,
          steps: [],
        });

        return {
          instructions: structuredClone(settings.instructions),
          messages: structuredClone(prepared.messages ?? call.messages),
          providerOptions: structuredClone(prepared.providerOptions),
          tools: Object.entries(settings.tools ?? {}).map(([name, tool]) => ({
            description: structuredClone(tool.description),
            inputSchema: structuredClone(tool.inputSchema),
            name,
            providerOptions: structuredClone(tool.providerOptions),
          })),
        };
      }

      const toolCallMessage = {
        content: [
          {
            input: { a: 1, b: 2 },
            toolCallId: "call-1",
            toolName: "add",
            type: "tool-call",
          },
        ],
        role: "assistant",
      } as const;
      const toolResultMessage = {
        content: [
          {
            output: "3",
            toolCallId: "call-1",
            toolName: "add",
            type: "tool-result",
          },
        ],
        role: "tool",
      } as const;
      const firstAnswerMessage = { content: "The answer is 3.", role: "assistant" } as const;
      const modelResults = [
        {
          finishReason: "tool-calls",
          response: { messages: [toolCallMessage, toolResultMessage] },
          text: "",
          toolCalls: [
            {
              input: { a: 1, b: 2 },
              toolCallId: "call-1",
              toolName: "add",
              type: "tool-call",
            },
          ],
          toolResults: [
            {
              input: { a: 1, b: 2 },
              output: "3",
              toolCallId: "call-1",
              toolName: "add",
              type: "tool-result",
            },
          ],
        },
        {
          finishReason: "stop",
          response: { messages: [firstAnswerMessage] },
          text: firstAnswerMessage.content,
          toolCalls: [],
          toolResults: [],
        },
        {
          finishReason: "stop",
          response: { messages: [{ content: "Confirmed.", role: "assistant" }] },
          text: "Confirmed.",
          toolCalls: [],
          toolResults: [],
        },
      ] satisfies Record<string, unknown>[];

      const tools = new Map([
        [
          "add",
          {
            description: "Adds numbers",
            execute: vi.fn().mockResolvedValue("3"),
            inputSchema: jsonSchema({ type: "object" }),
            name: "add",
          },
        ],
        [
          "lookup",
          {
            description: "Looks up a saved result",
            execute: vi.fn().mockResolvedValue("saved"),
            inputSchema: jsonSchema({ type: "object" }),
            name: "lookup",
          },
        ],
      ]);
      const config = createTestConfig("conversation", undefined, {
        resolveModel: vi.fn().mockResolvedValue("anthropic/claude-sonnet-4-5"),
        tools,
      });
      const session = createTestSession({
        agent: {
          modelReference: { id: "anthropic/claude-sonnet-4-5" },
          system: "You are a test assistant.",
          tools: [
            { description: "Adds numbers", inputSchema: { type: "object" }, name: "add" },
            {
              description: "Looks up a saved result",
              inputSchema: { type: "object" },
              name: "lookup",
            },
          ],
        },
      });
      const runStep = createToolLoopHarness(config);

      setupMockAgent(modelResults[0]!);
      const firstStep = await runStep(session, { message: "Add 1 and 2." });
      expect(firstStep.next).toBe(runStep);

      setupMockAgent(modelResults[1]!);
      const secondStep = await runStep(firstStep.session);
      expect(secondStep.next).toBeNull();

      setupMockAgent(modelResults[2]!);
      const nextTurn = await runStep(secondStep.session, { message: "Can you confirm?" });
      expect(nextTurn.next).toBeNull();
      const modelCalls = await Promise.all([0, 1, 2].map(captureModelCall));
      expect(modelCalls).toHaveLength(3);

      const firstPrompt = modelCalls[0]!;
      const secondPrompt = modelCalls[1]!;
      const nextTurnPrompt = modelCalls[2]!;

      expect(secondPrompt.messages.slice(0, firstPrompt.messages.length)).toEqual(
        firstPrompt.messages,
      );
      expect(nextTurnPrompt.messages.slice(0, secondPrompt.messages.length)).toEqual(
        secondPrompt.messages,
      );
      expect(modelCalls.map((call) => call.instructions)).toEqual([
        "You are a test assistant.",
        "You are a test assistant.",
        "You are a test assistant.",
      ]);
      expect(firstPrompt.tools).toEqual([
        {
          description: "Adds numbers",
          inputSchema: { type: "object" },
          name: "add",
          providerOptions: undefined,
        },
        {
          description: "Looks up a saved result",
          inputSchema: { type: "object" },
          name: "lookup",
          providerOptions: undefined,
        },
      ]);
      expect(modelCalls.map((call) => call.tools)).toEqual([
        firstPrompt.tools,
        firstPrompt.tools,
        firstPrompt.tools,
      ]);
      expect(modelCalls.map((call) => call.providerOptions)).toEqual([
        { gateway: { caching: "auto" } },
        { gateway: { caching: "auto" } },
        { gateway: { caching: "auto" } },
      ]);
      expect(modelCalls.map((call) => call.messages)).toEqual([
        [{ content: "Add 1 and 2.", role: "user" }],
        [{ content: "Add 1 and 2.", role: "user" }, toolCallMessage, toolResultMessage],
        [
          { content: "Add 1 and 2.", role: "user" },
          toolCallMessage,
          toolResultMessage,
          firstAnswerMessage,
          { content: "Can you confirm?", role: "user" },
        ],
      ]);
    });

    it("gateway-auto path: merges gateway.caching='auto' into providerOptions for string model ids", async () => {
      setupStopResult();
      const config: ToolLoopHarnessConfig = {
        mode: "conversation",
        resolveModel: vi.fn().mockResolvedValue("anthropic/claude-sonnet-4-5"),
        tools: new Map([
          [
            "add",
            {
              description: "Adds numbers",
              execute: vi.fn(),
              inputSchema: jsonSchema({ type: "object" }),
              name: "add",
            },
          ],
        ]),
      };
      const runStep = createToolLoopHarness(config);
      await runStep(createTestSession(), { message: "hi" });

      const agentCall = vi.mocked(ToolLoopAgent).mock.calls[0]?.[0];
      // providerOptions is now returned by prepareStep, not set on the constructor
      const prepareStep = getPrepareStep<unknown[], { providerOptions?: unknown }>(
        agentCall?.prepareStep,
      );
      const stepResult = await prepareStep({
        messages: [],
        stepNumber: 0,
        steps: [],
        model: null,
        context: undefined,
      });
      expect(stepResult.providerOptions).toEqual({
        gateway: { caching: "auto" },
      });
    });

    it("gateway-auto path: preserves author-provided gateway.order", async () => {
      setupStopResult();
      const session = createTestSession({
        agent: {
          modelReference: {
            id: "anthropic/claude-sonnet-4-5",
            providerOptions: { gateway: { order: ["anthropic", "bedrock"] } },
          },
          system: "",
          tools: [{ description: "Adds numbers", name: "add", inputSchema: { type: "object" } }],
        },
      });
      const config: ToolLoopHarnessConfig = {
        mode: "conversation",
        resolveModel: vi.fn().mockResolvedValue("anthropic/claude-sonnet-4-5"),
        tools: new Map([
          [
            "add",
            {
              description: "Adds numbers",
              execute: vi.fn(),
              inputSchema: jsonSchema({ type: "object" }),
              name: "add",
            },
          ],
        ]),
      };
      const runStep = createToolLoopHarness(config);
      await runStep(session, { message: "hi" });

      const agentCall = vi.mocked(ToolLoopAgent).mock.calls[0]?.[0];
      // providerOptions is now returned by prepareStep, not set on the constructor
      const prepareStep = getPrepareStep<unknown[], { providerOptions?: unknown }>(
        agentCall?.prepareStep,
      );
      const stepResult = await prepareStep({
        messages: [],
        stepNumber: 0,
        steps: [],
        model: null,
        context: undefined,
      });
      expect(stepResult.providerOptions).toEqual({
        gateway: { order: ["anthropic", "bedrock"], caching: "auto" },
      });
    });

    it("gateway-auto path: respects author override of gateway.caching", async () => {
      setupStopResult();
      const session = createTestSession({
        agent: {
          modelReference: {
            id: "anthropic/claude-sonnet-4-5",
            providerOptions: { gateway: { caching: false } },
          },
          system: "",
          tools: [{ description: "Adds numbers", name: "add", inputSchema: { type: "object" } }],
        },
      });
      const config: ToolLoopHarnessConfig = {
        mode: "conversation",
        resolveModel: vi.fn().mockResolvedValue("anthropic/claude-sonnet-4-5"),
        tools: new Map([
          [
            "add",
            {
              description: "Adds numbers",
              execute: vi.fn(),
              inputSchema: jsonSchema({ type: "object" }),
              name: "add",
            },
          ],
        ]),
      };
      const runStep = createToolLoopHarness(config);
      await runStep(session, { message: "hi" });

      const agentCall = vi.mocked(ToolLoopAgent).mock.calls[0]?.[0];
      // providerOptions is now returned by prepareStep, not set on the constructor
      const prepareStep = getPrepareStep<unknown[], { providerOptions?: unknown }>(
        agentCall?.prepareStep,
      );
      const stepResult = await prepareStep({
        messages: [],
        stepNumber: 0,
        steps: [],
        model: null,
        context: undefined,
      });
      expect(stepResult.providerOptions).toEqual({
        gateway: { caching: false },
      });
    });

    it("anthropic-direct path: adds prepareStep and marks the last tool", async () => {
      setupStopResult();
      const config: ToolLoopHarnessConfig = {
        mode: "conversation",
        resolveModel: vi.fn().mockResolvedValue({
          provider: "anthropic.messages",
          modelId: "claude-sonnet-4-5",
          specificationVersion: "v3",
        } as unknown as LanguageModel),
        tools: new Map([
          [
            "add",
            {
              description: "Adds numbers",
              execute: vi.fn(),
              inputSchema: jsonSchema({ type: "object" }),
              name: "add",
            },
          ],
        ]),
      };
      const runStep = createToolLoopHarness(config);
      await runStep(createTestSession(), { message: "hi" });

      const agentCall = vi.mocked(ToolLoopAgent).mock.calls[0]?.[0];
      expect(typeof agentCall?.prepareStep).toBe("function");

      const toolsPassed = agentCall?.tools as Record<
        string,
        { providerOptions?: Record<string, unknown> }
      >;
      const toolEntries = Object.entries(toolsPassed);
      const lastTool = toolEntries[toolEntries.length - 1]?.[1];
      expect(lastTool?.providerOptions).toEqual({
        anthropic: { cacheControl: { type: "ephemeral" } },
      });
    });

    it("anthropic-direct path: prepareStep marks last user and last assistant messages", async () => {
      setupStopResult();
      const config: ToolLoopHarnessConfig = {
        mode: "conversation",
        resolveModel: vi.fn().mockResolvedValue({
          provider: "anthropic.messages",
          modelId: "claude-sonnet-4-5",
          specificationVersion: "v3",
        } as unknown as LanguageModel),
        tools: new Map([
          [
            "add",
            {
              description: "Adds numbers",
              execute: vi.fn(),
              inputSchema: jsonSchema({ type: "object" }),
              name: "add",
            },
          ],
        ]),
      };
      const runStep = createToolLoopHarness(config);
      const session = createTestSession({
        history: [
          { content: "a", role: "user" },
          { content: "b", role: "assistant" },
        ],
      });
      await runStep(session, { message: "c" });

      const agentCall = vi.mocked(ToolLoopAgent).mock.calls[0]?.[0];
      const prepareStep = getPrepareStep<
        Array<{ role: string; content: string; providerOptions?: unknown }>,
        { messages?: Array<{ providerOptions?: unknown }> }
      >(agentCall?.prepareStep);

      const result = await prepareStep({
        messages: [
          { role: "user", content: "a" },
          { role: "assistant", content: "b" },
          { role: "user", content: "c" },
        ],
        stepNumber: 0,
        steps: [],
        model: null,
        context: undefined,
      });

      expect(result.messages?.[0]?.providerOptions).toBeUndefined();
      expect(result.messages?.[1]?.providerOptions).toEqual({
        anthropic: { cacheControl: { type: "ephemeral" } },
      });
      expect(result.messages?.[2]?.providerOptions).toEqual({
        anthropic: { cacheControl: { type: "ephemeral" } },
      });
    });

    it("none path: direct OpenAI instance gets no caching changes", async () => {
      setupStopResult();
      const config: ToolLoopHarnessConfig = {
        mode: "conversation",
        resolveModel: vi.fn().mockResolvedValue({
          provider: "openai.chat",
          modelId: "gpt-5",
          specificationVersion: "v3",
        } as unknown as LanguageModel),
        tools: new Map([
          [
            "add",
            {
              description: "Adds numbers",
              execute: vi.fn(),
              inputSchema: jsonSchema({ type: "object" }),
              name: "add",
            },
          ],
        ]),
      };
      const runStep = createToolLoopHarness(config);
      await runStep(createTestSession(), { message: "hi" });

      const agentCall = vi.mocked(ToolLoopAgent).mock.calls[0]?.[0];
      // For the "none" cache path, prepareStep does not add providerOptions
      const prepareStep = getPrepareStep<unknown[], { providerOptions?: unknown }>(
        agentCall?.prepareStep,
      );
      const stepResult = await prepareStep({
        messages: [],
        stepNumber: 0,
        steps: [],
        model: null,
        context: undefined,
      });
      expect(stepResult.providerOptions).toBeUndefined();
      expect(agentCall?.providerOptions).toBeUndefined();
      const toolsPassed = agentCall?.tools as Record<
        string,
        { providerOptions?: Record<string, unknown> }
      >;
      const lastTool = Object.entries(toolsPassed).at(-1)?.[1];
      expect(lastTool?.providerOptions).toBeUndefined();
    });

    it("step.completed event includes usage and cache stats", async () => {
      setupMockAgent({
        finishReason: "stop",
        providerMetadata: {
          gateway: {
            cost: "0.0123",
            generationId: "gen_test_gateway",
          },
        },
        response: { messages: [{ content: "done", role: "assistant" }] },
        text: "done",
        toolCalls: [],
        toolResults: [],
        usage: {
          inputTokens: 1000,
          outputTokens: 50,
          inputTokenDetails: {
            noCacheTokens: 0,
            cacheReadTokens: 800,
            cacheWriteTokens: 200,
          },
        },
      });

      const { emit, events } = createEventCollector();
      const runStep = createToolLoopHarness(createTestConfig("conversation", emit));
      await runStep(createTestSession(), { message: "hi" });

      const stepCompleted = events.find((e) => e.type === "step.completed");
      expect(stepCompleted?.data.usage).toEqual({
        costUsd: 0.0123,
        inputTokens: 1000,
        outputTokens: 50,
        cacheReadTokens: 800,
        cacheWriteTokens: 200,
      });
      expect(stepCompleted?.data.providerMetadata).toEqual({
        gateway: { generationId: "gen_test_gateway" },
      });
    });

    it("step.completed event omits usage when the model reports none", async () => {
      setupMockAgent({
        finishReason: "stop",
        response: { messages: [{ content: "done", role: "assistant" }] },
        text: "done",
        toolCalls: [],
        toolResults: [],
      });

      const { emit, events } = createEventCollector();
      const runStep = createToolLoopHarness(createTestConfig("conversation", emit));
      await runStep(createTestSession(), { message: "hi" });

      const stepCompleted = events.find((e) => e.type === "step.completed");
      expect(stepCompleted?.data.usage).toBeUndefined();
    });

    it("step.completed event includes gateway cost when tokens are absent", async () => {
      setupMockAgent({
        finishReason: "stop",
        providerMetadata: {
          gateway: {
            cost: 0.0042,
            generationId: "gen_cost_only",
          },
        },
        response: { messages: [{ content: "done", role: "assistant" }] },
        text: "done",
        toolCalls: [],
        toolResults: [],
      });

      const { emit, events } = createEventCollector();
      const runStep = createToolLoopHarness(createTestConfig("conversation", emit));
      await runStep(createTestSession(), { message: "hi" });

      const stepCompleted = events.find((e) => e.type === "step.completed");
      expect(stepCompleted?.data.usage).toEqual({ costUsd: 0.0042 });
      expect(stepCompleted?.data.providerMetadata).toEqual({
        gateway: { generationId: "gen_cost_only" },
      });
    });
  });

  describe("gateway app attribution headers", () => {
    function setupStopResultForAttribution(): void {
      setupMockAgent({
        finishReason: "stop",
        response: { messages: [{ content: "ok", role: "assistant" }] },
        text: "ok",
        toolCalls: [],
        toolResults: [],
      });
    }

    it("sets x-title and http-referer headers for gateway-routed string models", async () => {
      setupStopResultForAttribution();
      const originalProductionUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;
      process.env.VERCEL_PROJECT_PRODUCTION_URL = "my-agent.vercel.app";
      try {
        const config: ToolLoopHarnessConfig = {
          mode: "conversation",
          resolveModel: vi.fn().mockResolvedValue("anthropic/claude-sonnet-4-5"),
          runtimeIdentity: {
            agentId: "weather-agent",
            agentName: "Weather Agent",
            eveVersion: "0.0.0",
            modelId: "anthropic/claude-sonnet-4-5",
          },
          tools: new Map(),
        };
        const runStep = createToolLoopHarness(config);
        await runStep(createTestSession(), { message: "hi" });

        const agentCall = vi.mocked(ToolLoopAgent).mock.calls[0]?.[0];
        expect(agentCall?.headers).toEqual({
          "x-title": "Weather Agent",
          "http-referer": "https://my-agent.vercel.app",
        });
      } finally {
        if (originalProductionUrl === undefined) {
          delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
        } else {
          process.env.VERCEL_PROJECT_PRODUCTION_URL = originalProductionUrl;
        }
      }
    });

    it("falls back to agentId when agentName is not set", async () => {
      setupStopResultForAttribution();
      const originalProductionUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;
      const originalUrl = process.env.VERCEL_URL;
      delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
      delete process.env.VERCEL_URL;
      try {
        const config: ToolLoopHarnessConfig = {
          mode: "conversation",
          resolveModel: vi.fn().mockResolvedValue("anthropic/claude-sonnet-4-5"),
          runtimeIdentity: {
            agentId: "weather-agent",
            eveVersion: "0.0.0",
            modelId: "anthropic/claude-sonnet-4-5",
          },
          tools: new Map(),
        };
        const runStep = createToolLoopHarness(config);
        await runStep(createTestSession(), { message: "hi" });

        const agentCall = vi.mocked(ToolLoopAgent).mock.calls[0]?.[0];
        expect(agentCall?.headers).toEqual({
          "x-title": "weather-agent",
        });
      } finally {
        if (originalProductionUrl !== undefined) {
          process.env.VERCEL_PROJECT_PRODUCTION_URL = originalProductionUrl;
        }
        if (originalUrl !== undefined) {
          process.env.VERCEL_URL = originalUrl;
        }
      }
    });

    it("uses VERCEL_URL when VERCEL_PROJECT_PRODUCTION_URL is not set", async () => {
      setupStopResultForAttribution();
      const originalProductionUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;
      const originalUrl = process.env.VERCEL_URL;
      delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
      process.env.VERCEL_URL = "preview-123.vercel.app";
      try {
        const config: ToolLoopHarnessConfig = {
          mode: "conversation",
          resolveModel: vi.fn().mockResolvedValue("anthropic/claude-sonnet-4-5"),
          runtimeIdentity: {
            agentId: "my-agent",
            agentName: "My Agent",
            eveVersion: "0.0.0",
            modelId: "anthropic/claude-sonnet-4-5",
          },
          tools: new Map(),
        };
        const runStep = createToolLoopHarness(config);
        await runStep(createTestSession(), { message: "hi" });

        const agentCall = vi.mocked(ToolLoopAgent).mock.calls[0]?.[0];
        expect(agentCall?.headers).toEqual({
          "x-title": "My Agent",
          "http-referer": "https://preview-123.vercel.app",
        });
      } finally {
        if (originalProductionUrl !== undefined) {
          process.env.VERCEL_PROJECT_PRODUCTION_URL = originalProductionUrl;
        }
        if (originalUrl === undefined) {
          delete process.env.VERCEL_URL;
        } else {
          process.env.VERCEL_URL = originalUrl;
        }
      }
    });

    it("does not set attribution headers for non-gateway model objects", async () => {
      setupStopResultForAttribution();
      const config: ToolLoopHarnessConfig = {
        mode: "conversation",
        resolveModel: vi.fn().mockResolvedValue({
          provider: "anthropic.messages",
          modelId: "claude-sonnet-4-5-20250514",
          specificationVersion: "v3",
        } as unknown as LanguageModel),
        runtimeIdentity: {
          agentId: "my-agent",
          agentName: "My Agent",
          eveVersion: "0.0.0",
          modelId: "anthropic/claude-sonnet-4-5",
        },
        tools: new Map(),
      };
      const runStep = createToolLoopHarness(config);
      await runStep(createTestSession(), { message: "hi" });

      const agentCall = vi.mocked(ToolLoopAgent).mock.calls[0]?.[0];
      expect(agentCall?.headers).toBeUndefined();
    });

    it("does not set headers when no runtimeIdentity and no deployment URL", async () => {
      setupStopResultForAttribution();
      const originalProductionUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;
      const originalUrl = process.env.VERCEL_URL;
      delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
      delete process.env.VERCEL_URL;
      try {
        const config: ToolLoopHarnessConfig = {
          mode: "conversation",
          resolveModel: vi.fn().mockResolvedValue("anthropic/claude-sonnet-4-5"),
          tools: new Map(),
        };
        const runStep = createToolLoopHarness(config);
        await runStep(createTestSession(), { message: "hi" });

        const agentCall = vi.mocked(ToolLoopAgent).mock.calls[0]?.[0];
        expect(agentCall?.headers).toBeUndefined();
      } finally {
        if (originalProductionUrl !== undefined) {
          process.env.VERCEL_PROJECT_PRODUCTION_URL = originalProductionUrl;
        }
        if (originalUrl !== undefined) {
          process.env.VERCEL_URL = originalUrl;
        }
      }
    });

    it("passes attribution headers to compaction generateText call", async () => {
      vi.mocked(shouldCompact).mockReturnValueOnce(true);
      vi.mocked(compactMessages).mockResolvedValueOnce([
        { content: "Summary of our conversation so far:", role: "user" },
        { content: "summary", role: "assistant" },
      ]);
      setupStopResultForAttribution();

      const originalProductionUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;
      process.env.VERCEL_PROJECT_PRODUCTION_URL = "my-agent.vercel.app";
      try {
        const { emit } = createEventCollector();
        const config: ToolLoopHarnessConfig = {
          handleEvent: emit,
          mode: "conversation",
          resolveModel: vi.fn().mockResolvedValue("anthropic/claude-sonnet-4-5"),
          runtimeIdentity: {
            agentId: "weather-agent",
            agentName: "Weather Agent",
            eveVersion: "0.0.0",
            modelId: "anthropic/claude-sonnet-4-5",
          },
          tools: new Map(),
        };
        const runStep = createToolLoopHarness(config);
        await runStep(createTestSession(), { message: "hi" });

        const compactCall = vi.mocked(compactMessages).mock.calls[0];
        expect(compactCall?.[5]).toEqual({
          "x-title": "Weather Agent",
          "http-referer": "https://my-agent.vercel.app",
        });
      } finally {
        if (originalProductionUrl === undefined) {
          delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
        } else {
          process.env.VERCEL_PROJECT_PRODUCTION_URL = originalProductionUrl;
        }
      }
    });
  });

  describe("turn trace propagation across step boundaries", () => {
    it("stores turn trace state on session when telemetry is enabled", async () => {
      setupMockAgent({
        finishReason: "tool-calls",
        response: {
          messages: [
            {
              content: [{ type: "tool-call", toolCallId: "call-1", toolName: "add", args: {} }],
              role: "assistant",
            },
            {
              content: [
                { type: "tool-result", toolCallId: "call-1", toolName: "add", output: "42" },
              ],
              role: "tool",
            },
          ],
        },
        text: "",
        toolCalls: [{ toolCallId: "call-1", toolName: "add", input: {} }],
        toolResults: [{ toolCallId: "call-1", toolName: "add", output: "42" }],
      });

      mockGetInstrumentationConfig.mockReturnValue({});
      const config = createTestConfig("conversation");
      const runStep = createToolLoopHarness(config);
      const result = await runStep(createTestSession(), { message: "add stuff" });
      mockGetInstrumentationConfig.mockReturnValue(undefined);

      expect(result.next).toBe(runStep);
      expect(result.session.state?.["eve.harness.turnTrace"]).toEqual({
        traceId: expect.any(String),
        spanId: expect.any(String),
        traceFlags: expect.any(Number),
      });
    });

    it("does not store turn trace state when telemetry is disabled", async () => {
      setupMockAgent({
        finishReason: "tool-calls",
        response: {
          messages: [
            {
              content: [{ type: "tool-call", toolCallId: "call-1", toolName: "add", args: {} }],
              role: "assistant",
            },
            {
              content: [
                { type: "tool-result", toolCallId: "call-1", toolName: "add", output: "42" },
              ],
              role: "tool",
            },
          ],
        },
        text: "",
        toolCalls: [{ toolCallId: "call-1", toolName: "add", input: {} }],
        toolResults: [{ toolCallId: "call-1", toolName: "add", output: "42" }],
      });

      const config = createTestConfig("conversation");
      const runStep = createToolLoopHarness(config);
      const result = await runStep(createTestSession(), { message: "add stuff" });

      expect(result.next).toBe(runStep);
      expect(result.session.state?.["eve.harness.turnTrace"]).toBeUndefined();
    });

    it("continuation step restores parent trace context from session state", async () => {
      // Step 1: tool call → continues
      setupMockAgent({
        finishReason: "tool-calls",
        response: {
          messages: [
            {
              content: [{ type: "tool-call", toolCallId: "call-1", toolName: "add", args: {} }],
              role: "assistant",
            },
            {
              content: [
                { type: "tool-result", toolCallId: "call-1", toolName: "add", output: "42" },
              ],
              role: "tool",
            },
          ],
        },
        text: "",
        toolCalls: [{ toolCallId: "call-1", toolName: "add", input: {} }],
        toolResults: [{ toolCallId: "call-1", toolName: "add", output: "42" }],
      });

      mockGetInstrumentationConfig.mockReturnValue({});
      const step1Config = createTestConfig("conversation");
      const step1 = createToolLoopHarness(step1Config);
      const result1 = await step1(createTestSession(), { message: "add stuff" });

      const storedTrace = result1.session.state?.["eve.harness.turnTrace"] as {
        traceId: string;
        spanId: string;
        traceFlags: number;
      };
      expect(storedTrace).toBeDefined();

      // Step 2: simulate step boundary by creating a NEW harness (as durableRunStep does).
      // Spy on trace.wrapSpanContext to verify the stored context is restored.
      const wrapSpy = vi.spyOn(trace, "wrapSpanContext");
      const withSpy = vi.spyOn(otelContext, "with");

      setupMockAgent({
        finishReason: "stop",
        response: { messages: [{ content: "Done!", role: "assistant" }] },
        text: "Done!",
        toolCalls: [],
        toolResults: [],
      });

      const step2Config = createTestConfig("conversation");
      const step2 = createToolLoopHarness(step2Config);
      // No input — continuation step
      const result2 = await step2(result1.session);
      mockGetInstrumentationConfig.mockReturnValue(undefined);

      expect(result2.next).toBeNull();

      // Verify the stored span context was restored
      expect(wrapSpy).toHaveBeenCalledWith({
        traceId: storedTrace.traceId,
        spanId: storedTrace.spanId,
        traceFlags: storedTrace.traceFlags,
      });

      // Verify context.with was called (AI SDK spans run under restored parent)
      expect(withSpy).toHaveBeenCalled();

      wrapSpy.mockRestore();
      withSpy.mockRestore();
    });
  });

  describe("telemetry metadata", () => {
    it("injects eve.version alongside session context into runtimeContext when telemetry is enabled", async () => {
      setupMockAgent({
        finishReason: "stop",
        response: { messages: [{ content: "Hello!", role: "assistant" }] },
        text: "Hello!",
        toolCalls: [],
        toolResults: [],
      });

      mockGetInstrumentationConfig.mockReturnValue({});
      const config = createTestConfig("conversation");
      const runStep = createToolLoopHarness(config);
      await runStep(createTestSession(), { message: "hi" });
      mockGetInstrumentationConfig.mockReturnValue(undefined);

      const agentCall = vi.mocked(ToolLoopAgent).mock.calls[0]?.[0] as {
        runtimeContext?: Record<string, unknown>;
        telemetry?: { isEnabled?: boolean };
      };
      const runtimeContext = agentCall?.runtimeContext;
      expect(runtimeContext).toBeDefined();
      expect(runtimeContext?.["eve.version"]).toEqual(expect.any(String));
      expect(runtimeContext?.["eve.version"]).not.toBe("");
      expect(runtimeContext?.["eve.session.id"]).toBe("test-session");
      expect(agentCall?.telemetry?.isEnabled).toBe(true);
    });

    it("merges step-started runtime context before emitting step.started", async () => {
      setupMockAgent({
        finishReason: "stop",
        response: { messages: [{ content: "Hello!", role: "assistant" }] },
        text: "Hello!",
        toolCalls: [],
        toolResults: [],
      });

      const order: string[] = [];
      const events: HandleMessageStreamEvent[] = [];
      const emit: HarnessEmitFn = async (event) => {
        order.push(event.type);
        events.push(event);
      };
      const resolveRuntimeContext = vi.fn((input: InstrumentationStepStartedEventInput) => {
        order.push('events["step.started"]');
        if (input.channel.kind !== "channel:support") {
          throw new Error("expected support channel metadata");
        }
        return {
          runtimeContext: {
            "eve.session.id": "user-override",
            "slack.user_id": input.channel.metadata.triggeringUserId ?? "",
            "turn.id": input.turn.id,
          },
        };
      });
      mockGetInstrumentationConfig.mockReturnValue({
        events: {
          "step.started": resolveRuntimeContext,
        },
      });

      const ctx = new ContextContainer();
      ctx.set(ChannelInstrumentationKey, {
        kind: "channel:support",
        metadata: {
          triggeringUserId: "U123",
        },
      });

      const config = createTestConfig("conversation", emit);
      const runStep = createToolLoopHarness(config);
      await contextStorage.run(ctx, () => runStep(createTestSession(), { message: "hi" }));

      const agentCall = vi.mocked(ToolLoopAgent).mock.calls[0]?.[0] as {
        runtimeContext?: Record<string, unknown>;
        telemetry?: { includeRuntimeContext?: Record<string, boolean> };
      };
      expect(resolveRuntimeContext).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          step: { index: 0 },
          turn: { id: "turn_0", sequence: 0 },
        }),
      );
      expect(agentCall?.runtimeContext).toMatchObject({
        "eve.channel.kind": "channel:support",
        "eve.session.id": "test-session",
        "eve.step.index": "0",
        "eve.turn.id": "turn_0",
        "eve.turn.sequence": "0",
        "slack.user_id": "U123",
        "turn.id": "turn_0",
      });
      expect(agentCall?.runtimeContext?.["eve.version"]).toEqual(expect.any(String));
      expect(agentCall?.telemetry?.includeRuntimeContext).toEqual(
        Object.fromEntries(Object.keys(agentCall?.runtimeContext ?? {}).map((key) => [key, true])),
      );
      expect(order.indexOf("turn.started")).toBeLessThan(order.indexOf('events["step.started"]'));
      expect(order.indexOf('events["step.started"]')).toBeLessThan(order.indexOf("step.started"));
      expect(getCompatibilityEventTypes(events)).toContain("step.started");
    });

    it("continues the normal turn flow when step-started runtime context throws", async () => {
      setupMockAgent({
        finishReason: "stop",
        response: { messages: [{ content: "Hello!", role: "assistant" }] },
        text: "Hello!",
        toolCalls: [],
        toolResults: [],
      });

      mockGetInstrumentationConfig.mockReturnValue({
        events: {
          "step.started": () => {
            throw new Error("runtime context resolver failed");
          },
        },
      });

      const { emit, events } = createEventCollector();
      const runStep = createToolLoopHarness(createTestConfig("conversation", emit));
      const result = await runStep(createTestSession(), { message: "hi" });

      expect(result.next).toBeNull();
      expect(getCompatibilityEventTypes(events)).toEqual([
        "session.started",
        "turn.started",
        "message.received",
        "step.started",
        "message.completed",
        "step.completed",
        "turn.completed",
        "session.waiting",
      ]);

      const agentCall = vi.mocked(ToolLoopAgent).mock.calls[0]?.[0] as {
        runtimeContext?: Record<string, unknown>;
      };
      expect(agentCall?.runtimeContext).toMatchObject({
        "eve.session.id": "test-session",
      });
    });

    it("resolves step-started runtime context for each step and turn coordinate", async () => {
      const resolveRuntimeContext = vi.fn((input: InstrumentationStepStartedEventInput) => ({
        runtimeContext: {
          "test.step": `${input.turn.id}:${input.step.index}`,
        },
      }));
      mockGetInstrumentationConfig.mockReturnValue({
        events: {
          "step.started": resolveRuntimeContext,
        },
      });

      const { emit } = createEventCollector();
      const config = createTestConfig("conversation", emit);
      const session = createTestSession();

      setupMockAgent({
        finishReason: "tool-calls",
        response: {
          messages: [
            {
              content: [
                { text: "Let me calculate that first.", type: "text" },
                {
                  input: { a: 1, b: 2 },
                  toolCallId: "call-1",
                  toolName: "add",
                  type: "tool-call",
                },
              ],
              role: "assistant",
            },
            {
              content: [
                { output: "42", toolCallId: "call-1", toolName: "add", type: "tool-result" },
              ],
              role: "tool",
            },
          ],
        },
        text: "",
        toolCalls: [
          { input: { a: 1, b: 2 }, toolCallId: "call-1", toolName: "add", type: "tool-call" },
        ],
        toolResults: [
          {
            input: { a: 1, b: 2 },
            output: "42",
            toolCallId: "call-1",
            toolName: "add",
            type: "tool-result",
          },
        ],
      });
      const firstResult = await createToolLoopHarness(config)(session, {
        message: "Add 1 and 2.",
      });
      expect(typeof firstResult.next).toBe("function");

      setupMockAgent({
        finishReason: "stop",
        response: { messages: [{ content: "42", role: "assistant" }] },
        text: "42",
        toolCalls: [],
        toolResults: [],
      });
      const secondResult = await createToolLoopHarness(config)(firstResult.session);
      expect(secondResult.next).toBeNull();

      setupMockAgent({
        finishReason: "stop",
        response: { messages: [{ content: "Still here.", role: "assistant" }] },
        text: "Still here.",
        toolCalls: [],
        toolResults: [],
      });
      const thirdResult = await createToolLoopHarness(config)(secondResult.session, {
        message: "Next turn.",
      });
      expect(thirdResult.next).toBeNull();

      expect(
        resolveRuntimeContext.mock.calls.map(([input]) => ({
          stepIndex: input.step.index,
          turnId: input.turn.id,
          turnSequence: input.turn.sequence,
        })),
      ).toEqual([
        { stepIndex: 0, turnId: "turn_0", turnSequence: 0 },
        { stepIndex: 1, turnId: "turn_0", turnSequence: 0 },
        { stepIndex: 0, turnId: "turn_1", turnSequence: 1 },
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // Attachment staging + hydration invariant
  // ---------------------------------------------------------------------------

  describe("attachment staging + hydration", () => {
    it("stages inlinable FilePart bytes into the sandbox, hydrates them as bytes for the model call, and persists refs (not bytes) to session.history", async () => {
      setupMockAgent({
        finishReason: "stop",
        response: { messages: [{ content: "ok", role: "assistant" }] },
        text: "ok",
        toolCalls: [],
        toolResults: [],
      });

      // Small PNG-like payload — under the 3 MiB image inline cap so
      // the hydration pass substitutes bytes (not a text reference).
      const imageBytes = Buffer.alloc(1024, 0x89);
      const userContent: UserContent = [
        { type: "text", text: "describe the image" },
        { data: imageBytes, filename: "logo.png", mediaType: "image/png", type: "file" },
      ];

      const sandbox = mockSandbox({ id: "sbx_tool_loop" });
      const ctx = new ContextContainer();
      ctx.set(SandboxKey, sandbox.access);

      const config = createTestConfig("conversation");
      const runStep = createToolLoopHarness(config);
      const session = createTestSession();

      const result = await contextStorage.run(ctx, async () =>
        runStep(session, { message: userContent }),
      );

      // --- Invariant 1: sandbox received the raw bytes exactly once.
      expect(sandbox.writes).toHaveLength(1);
      const [firstWrite] = sandbox.writes;
      expect(firstWrite).toBeDefined();
      expect((firstWrite!.content as Buffer).equals(imageBytes)).toBe(true);

      // --- Invariant 2: session.history carries a sandbox ref, not bytes.
      const historyUserMsg = result.session.history[0];
      expect(historyUserMsg?.role).toBe("user");
      const historyContent = historyUserMsg?.content as Exclude<UserContent, string>;
      const historyFilePart = historyContent.find(
        (p) => (p as FilePart).type === "file",
      ) as FilePart;
      expect(isSandboxRefUrl(historyFilePart.data)).toBe(true);
      const historyRef = decodeSandboxRef(historyFilePart.data as URL);
      expect(historyRef.mediaType).toBe("image/png");
      expect(historyRef.size).toBe(imageBytes.byteLength);
      expect(historyRef.path).toMatch(/^\/workspace\/attachments\/[0-9a-f]{16}\/logo\.png$/);

      // --- Invariant 3: the mocked ToolLoopAgent.generate saw hydrated bytes.
      //
      // The mock constructor ran once; grab the generate spy (no `emit`
      // was passed on the config, so the harness takes the non-streaming
      // branch) and verify the messages it received had `data: Buffer`
      // for the FilePart.
      const mockInstance = vi.mocked(ToolLoopAgent).mock.results[0]?.value as {
        generate: ReturnType<typeof vi.fn>;
        stream: ReturnType<typeof vi.fn>;
      };
      expect(mockInstance).toBeDefined();
      const modelCall = mockInstance.generate.mock.calls[0]?.[0] as {
        messages: Array<{
          content: Array<{ type: string; data?: unknown; mediaType?: string }>;
        }>;
      };
      expect(modelCall).toBeDefined();
      const firstMessage = modelCall.messages[0];
      expect(firstMessage).toBeDefined();
      const streamFilePart = firstMessage!.content.find((p) => p.type === "file");
      expect(streamFilePart).toBeDefined();
      expect(Buffer.isBuffer(streamFilePart!.data)).toBe(true);
      expect((streamFilePart!.data as Buffer).equals(imageBytes)).toBe(true);
      expect(streamFilePart!.mediaType).toBe("image/png");
    });

    it("stages non-inlinable FilePart bytes into the sandbox and hands the model a text reference instead of bytes", async () => {
      setupMockAgent({
        finishReason: "stop",
        response: { messages: [{ content: "ok", role: "assistant" }] },
        text: "ok",
        toolCalls: [],
        toolResults: [],
      });

      const csvBytes = Buffer.from("id,name\n1,alpha\n", "utf8");
      const userContent: UserContent = [
        { type: "text", text: "summarize" },
        { data: csvBytes, filename: "report.csv", mediaType: "text/csv", type: "file" },
      ];

      const sandbox = mockSandbox({ id: "sbx_tool_loop_text_ref" });
      const ctx = new ContextContainer();
      ctx.set(SandboxKey, sandbox.access);

      const config = createTestConfig("conversation");
      const runStep = createToolLoopHarness(config);
      const session = createTestSession();

      const result = await contextStorage.run(ctx, async () =>
        runStep(session, { message: userContent }),
      );

      // Bytes still land in the sandbox — the agent's filesystem
      // tools reach them through the path the text reference
      // advertises.
      expect(sandbox.writes).toHaveLength(1);
      expect((sandbox.writes[0]!.content as Buffer).equals(csvBytes)).toBe(true);

      // History still carries the ref (not a text summary) — the
      // inlining decision is re-evaluated on every step from the
      // same stable wire format.
      const historyContent = result.session.history[0]?.content as Exclude<UserContent, string>;
      const historyFilePart = historyContent.find(
        (p) => (p as FilePart).type === "file",
      ) as FilePart;
      expect(isSandboxRefUrl(historyFilePart.data)).toBe(true);
      const historyRef = decodeSandboxRef(historyFilePart.data as URL);
      expect(historyRef.mediaType).toBe("text/csv");

      // The model-facing content swapped the non-inlinable FilePart
      // for a TextPart naming the sandbox path.
      const mockInstance = vi.mocked(ToolLoopAgent).mock.results[0]?.value as {
        generate: ReturnType<typeof vi.fn>;
        stream: ReturnType<typeof vi.fn>;
      };
      const modelCall = mockInstance.generate.mock.calls[0]?.[0] as {
        messages: Array<{
          content: Array<{ type: string; text?: string; data?: unknown }>;
        }>;
      };
      const firstMessage = modelCall.messages[0]!;
      // Original TextPart survives alongside the synthesized reference.
      expect(firstMessage.content[0]).toEqual({ type: "text", text: "summarize" });
      // No FilePart reaches the model for the non-inlinable CSV.
      expect(firstMessage.content.find((p) => p.type === "file")).toBeUndefined();
      // The CSV turns into a text reference pointing at the staged
      // sandbox path.
      expect(firstMessage.content[1]).toEqual({
        text: `Attached file ${historyRef.path} (text/csv)`,
        type: "text",
      });
    });
  });

  describe("ephemeral context routing", () => {
    function getLastAgentSettings(): {
      instructions: unknown;
      messages: Array<{ role: string; content: unknown }>;
    } {
      const settings = vi.mocked(ToolLoopAgent).mock.calls.at(-1)?.[0] as {
        instructions: unknown;
      };
      const instance = vi.mocked(ToolLoopAgent).mock.results.at(-1)?.value as {
        generate: ReturnType<typeof vi.fn>;
      };
      const call = instance.generate.mock.calls[0]?.[0] as {
        messages: Array<{ role: string; content: unknown }>;
      };
      return { instructions: settings.instructions, messages: call.messages };
    }

    function defaultModelResult(): Record<string, unknown> {
      return {
        finishReason: "stop",
        response: { messages: [{ content: "ok", role: "assistant" }] },
        text: "ok",
        toolCalls: [],
        toolResults: [],
      };
    }

    it("appends context strings as user messages", async () => {
      setupMockAgent(defaultModelResult());
      const runStep = createToolLoopHarness(createTestConfig("conversation"));
      const session = createTestSession();

      await runStep(session, {
        message: "Hi",
        context: ["ephemeral-context"],
      });

      const { messages } = getLastAgentSettings();
      const contextMessage = messages.find((m) => m.content === "ephemeral-context");
      expect(contextMessage).toBeDefined();
      expect(contextMessage!.role).toBe("user");
    });

    it("routes role:system durable history into instructions, not messages", async () => {
      setupMockAgent(defaultModelResult());
      const runStep = createToolLoopHarness(createTestConfig("conversation"));
      const session = createTestSession({
        history: [{ role: "system", content: "durable-system" }],
      });

      await runStep(session, { message: "Hi" });

      const { instructions, messages } = getLastAgentSettings();
      expect(instructions).toEqual([
        { role: "system", content: "You are a test assistant." },
        { role: "system", content: "durable-system" },
      ]);
      expect(messages.find((m) => m.role === "system")).toBeUndefined();
      expect(messages.at(-1)).toEqual({ role: "user", content: "Hi" });
    });

    it("persists context strings in session history as user messages", async () => {
      setupMockAgent(defaultModelResult());
      const runStep = createToolLoopHarness(createTestConfig("conversation"));
      const session = createTestSession();

      const result = await runStep(session, {
        message: "Hi",
        context: ["background-context"],
      });

      expect(result.session.history).toEqual([
        { role: "user", content: "background-context" },
        { role: "user", content: "Hi" },
        { role: "assistant", content: "ok" },
      ]);
    });

    it("leaves instructions unchanged when no context is provided", async () => {
      setupMockAgent(defaultModelResult());
      const runStep = createToolLoopHarness(createTestConfig("conversation"));
      const session = createTestSession();

      await runStep(session, { message: "Hi" });

      const { instructions } = getLastAgentSettings();
      expect(instructions).toBe("You are a test assistant.");
    });

    it.each(["conversation", "task"] as const)(
      "adds conditional-delivery guidance to a top-level scheduled %s turn",
      async (mode) => {
        setupMockAgent(defaultModelResult());
        const runStep = createToolLoopHarness(createTestConfig(mode));

        await contextStorage.run(createScheduleContext(), () =>
          runStep(createTestSession(), { message: "Check for alerts." }),
        );

        const { instructions } = getLastAgentSettings();
        expect(instructions).toEqual([
          { role: "system", content: "You are a test assistant." },
          { role: "system", content: CONDITIONAL_DELIVERY_INSTRUCTION },
        ]);
      },
    );

    it.each(["conversation", "task"] as const)(
      "does not add conditional-delivery guidance when a scheduled %s turn has an output schema",
      async (mode) => {
        setupMockAgent(finalOutputResult("Done.", { status: "ok" }));
        const runStep = createToolLoopHarness(createTestConfig(mode));

        await contextStorage.run(createScheduleContext(), () =>
          runStep(createTestSession({ outputSchema: { type: "object" } }), {
            message: "Check for alerts.",
          }),
        );

        const { instructions } = getLastAgentSettings();
        expect(instructions).toBe("You are a test assistant.");
      },
    );

    it("does not add conditional-delivery guidance to an ordinary task run", async () => {
      setupMockAgent(defaultModelResult());
      const runStep = createToolLoopHarness(createTestConfig("task"));

      await runStep(createTestSession(), { message: "Run this task." });

      const { instructions } = getLastAgentSettings();
      expect(instructions).toBe("You are a test assistant.");
    });

    it("does not add conditional-delivery guidance to a human continuation", async () => {
      setupMockAgent(defaultModelResult());
      const runStep = createToolLoopHarness(createTestConfig("conversation"));
      const ctx = createScheduleContext();
      ctx.set(AuthKey, {
        attributes: {},
        authenticator: "slack",
        principalId: "U123",
        principalType: "user",
      });

      await contextStorage.run(ctx, () =>
        runStep(createTestSession(), { message: "What happened?" }),
      );

      const { instructions } = getLastAgentSettings();
      expect(instructions).toBe("You are a test assistant.");
    });

    it("does not add conditional-delivery guidance to a delegated run", async () => {
      setupMockAgent(defaultModelResult());
      const runStep = createToolLoopHarness(createTestConfig("task"));
      const ctx = createScheduleContext();
      setDelegatedParent(ctx);

      await contextStorage.run(ctx, () =>
        runStep(createTestSession(), { message: "Handle delegated work." }),
      );

      const { instructions } = getLastAgentSettings();
      expect(instructions).toBe("You are a test assistant.");
    });

    it("routes dynamic instruction messages from durable keys into instructions", async () => {
      setupMockAgent(defaultModelResult());
      const runStep = createToolLoopHarness(createTestConfig("conversation"));
      const session = createTestSession();

      const ctx = new ContextContainer();
      ctx.set(SessionDynamicInstructionsKey, {
        context: [{ role: "system" as const, content: "dynamic-system-instruction" }],
      });

      await contextStorage.run(ctx, () => runStep(session, { message: "Hi" }));

      const { instructions, messages } = getLastAgentSettings();
      expect(instructions).toEqual([
        { role: "system", content: "You are a test assistant." },
        { role: "system", content: "dynamic-system-instruction" },
      ]);
      expect(messages.find((m) => m.content === "dynamic-system-instruction")).toBeUndefined();
    });

    it("does not persist dynamic instruction messages to session history", async () => {
      setupMockAgent(defaultModelResult());
      const runStep = createToolLoopHarness(createTestConfig("conversation"));
      const session = createTestSession();

      const ctx = new ContextContainer();
      ctx.set(SessionDynamicInstructionsKey, {
        context: [{ role: "system" as const, content: "dynamic-sys" }],
      });

      const result = await contextStorage.run(ctx, () => runStep(session, { message: "Hi" }));

      expect(result.session.history).toEqual([
        { role: "user", content: "Hi" },
        { role: "assistant", content: "ok" },
      ]);
    });
  });

  describe("tool execution error logging", () => {
    function getLastAgentCallbacks(): {
      onToolExecutionEnd?: (event: {
        toolCall: { toolName: string; toolCallId: string };
        toolOutput: { type: string; error?: unknown };
      }) => void;
      onError?: (event: { error: unknown }) => void;
    } {
      return vi.mocked(ToolLoopAgent).mock.calls.at(-1)?.[0] as ReturnType<
        typeof getLastAgentCallbacks
      >;
    }

    async function runOnce(): Promise<void> {
      setupMockAgent({
        finishReason: "stop",
        response: { messages: [{ content: "ok", role: "assistant" }] },
        text: "ok",
        toolCalls: [],
        toolResults: [],
      });
      await createToolLoopHarness(createTestConfig("conversation"))(createTestSession(), {
        message: "Hi",
      });
    }

    it("logs the full Error (stack/cause) when a tool execution fails", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      await runOnce();

      const { onToolExecutionEnd } = getLastAgentCallbacks();
      expect(onToolExecutionEnd).toBeTypeOf("function");

      const cause = Object.assign(new Error("upstream 500"), { statusCode: 500 });
      onToolExecutionEnd!({
        toolCall: { toolName: "add", toolCallId: "call_1" },
        toolOutput: { type: "tool-error", error: new Error("boom in tool", { cause }) },
      });

      const logged = errorSpy.mock.calls.find(([line]) =>
        String(line).includes("tool execution failed"),
      );
      expect(logged).toBeDefined();
      const [line, payload] = logged!;
      expect(line).toBe("[eve:harness.tool-loop] tool execution failed");
      expect(payload).toMatchObject({
        toolName: "add",
        toolCallId: "call_1",
        error: {
          message: expect.stringContaining("boom in tool"),
          detail: expect.stringContaining("upstream 500"),
          errorId: expect.any(String),
        },
      });
      errorSpy.mockRestore();
    });

    it("does not log on a successful tool output", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      await runOnce();

      const { onToolExecutionEnd } = getLastAgentCallbacks();
      onToolExecutionEnd!({
        toolCall: { toolName: "add", toolCallId: "call_1" },
        toolOutput: { type: "tool-result" },
      });

      expect(
        errorSpy.mock.calls.some(([line]) => String(line).includes("tool execution failed")),
      ).toBe(false);
      errorSpy.mockRestore();
    });

    it("logs stream/tool-loop errors via onError", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      await runOnce();

      const { onError } = getLastAgentCallbacks();
      expect(onError).toBeTypeOf("function");
      onError!({ error: new Error("stream blew up") });

      const logged = errorSpy.mock.calls.find(([line]) =>
        String(line).includes("tool-loop stream error"),
      );
      expect(logged).toBeDefined();
      errorSpy.mockRestore();
    });

    it("skips the raw dump for recognized configuration failures", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      await runOnce();

      const { onError } = getLastAgentCallbacks();
      const gatewayAuthError = Object.assign(
        new Error("AI Gateway authentication failed: No authentication provided."),
        { name: "GatewayAuthenticationError" },
      );
      onError!({ error: gatewayAuthError });

      expect(
        errorSpy.mock.calls.some(([line]) => String(line).includes("tool-loop stream error")),
      ).toBe(false);
      errorSpy.mockRestore();
    });
  });
});
