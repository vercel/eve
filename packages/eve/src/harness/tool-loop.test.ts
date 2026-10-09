import { context as otelContext, trace } from "#compiled/@opentelemetry/api/index.js";
import {
  type FilePart,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  streamText,
  ToolLoopAgent,
  type UserContent,
} from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextContainer, contextStorage } from "#context/container.js";
import { DynamicModelSelectionError } from "#context/dynamic-model-lifecycle.js";
import { resolveDynamicInstructions } from "#context/dynamic-instruction-lifecycle.js";
import {
  AuthKey,
  ChannelInstrumentationKey,
  ConversationIdKey,
  HistoryStateKey,
  LiveStepDynamicModelSelectionKey,
  ParentSessionKey,
  SandboxKey,
  SessionTraceSeedKey,
  SessionIdKey,
  SessionDynamicInstructionsKey,
  SessionDynamicModelReferenceKey,
} from "#context/keys.js";
import { invocationOwnerKey } from "#internal/invocation/metadata.js";
import { decodeSandboxRef, isSandboxRefUrl } from "#internal/attachments/sandbox-refs.js";
import { attachClientContext } from "#internal/client-context.js";
import { pngBytes } from "#internal/testing/media-fixtures.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { InstrumentationStepStartedEventInput } from "#public/instrumentation/index.js";
import { defineInstructions } from "#public/definitions/instructions.js";
import type { ResolvedDynamicInstructionsResolver } from "#runtime/types.js";
import type { DynamicResolveContext } from "#dynamic/definition.js";
import type { ChannelAudience } from "#shared/channel-audience.js";
import {
  ConversationContextKey,
  type ConversationEnvironment,
  type ConversationContext,
} from "#shared/conversation-context.js";
import type { InstrumentationDecision } from "#shared/instrumentation-decision.js";
import { compactMessages, shouldCompact } from "#harness/compaction/engine.js";
import {
  createFrameworkUserMessage,
  createUserMessage,
  type HarnessModelMessage,
} from "#harness/messages.js";
import { applyTransition, sessionView } from "#harness/session-machine/commit.js";
import { requireSignIn } from "#harness/hitl/approvals.js";
import { createAuthorizationRequiredEvent } from "#protocol/message.js";
import { runtimeWait, storedProjection } from "#harness/session-machine/view.js";
import {
  foldingHandler,
  positionOf,
  withOpenTurn,
  withPublished,
  withParkedStep,
} from "#internal/testing/session-machine.js";
import { appendMissingToolResultMessages } from "#harness/model-call/response.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import { createTask, writeTaskTable } from "#execution/tasks/table.js";
import { SessionLimitDeclinedError, TurnCancelledError } from "#harness/turn-cancellation.js";
import {
  getSessionUsageLimitViolation,
  getSessionTokenUsage,
  setTurnUsageState,
} from "#harness/turn-tag-state.js";
import type {
  HarnessEmitFn,
  HarnessSession,
  StepParticipants,
  ToolLoopHarnessConfig,
} from "#harness/types.js";
import {
  createInstrumentationHooks,
  type InstrumentationContextRunner,
} from "#instrumentation/lifecycle.js";
import {
  bindInstrumentationRuntime,
  type InstrumentationRuntime,
  type SessionInstrumentation,
} from "#instrumentation/runtime.js";
import type { RuntimeContextResolver } from "#tracing/otel-declaration.js";
import { captureLogRecords } from "#internal/testing/log-records.js";
import { countRunUsage } from "#execution/agent-sessions/usage.js";

// The harness runs outside a workflow body here, where run attributes cannot
// be written; the attribute contract is covered by emit.test.ts.
vi.mock("#runtime/attributes/emit.js", () => ({ setEveAttributes: vi.fn(async () => {}) }));

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  ToolLoopAgent: vi.fn(),
  streamText: vi.fn(),
  gateway: {
    tools: {
      exaSearch: vi.fn(() => ({})),
      parallelSearch: vi.fn(() => ({})),
    },
  },
  isStepCount: vi.fn((n: number) => n),
  tool: vi.fn((t: unknown) => t),
}));

const {
  mockCreateAiSdkHookBridge,
  mockGetRegisteredTelemetryIntegrations,
  registeredAuthorIntegration,
  registeredOtelIntegration,
} = vi.hoisted(() => ({
  mockCreateAiSdkHookBridge: vi.fn((..._args: unknown[]) => ({ onStart: vi.fn() })),
  mockGetRegisteredTelemetryIntegrations: vi.fn(
    (_options?: { readonly sanitizeEveOtelErrors?: boolean }): unknown[] => [],
  ),
  registeredAuthorIntegration: { onStart: vi.fn() },
  registeredOtelIntegration: { onStart: vi.fn() },
}));

vi.mock("#instrumentation/ai-sdk-hook-bridge.js", () => ({
  createAiSdkHookBridge: (...args: unknown[]) => mockCreateAiSdkHookBridge(...args),
}));

vi.mock("#instrumentation/ai-sdk-telemetry.js", () => ({
  ensureOtelIntegration: vi.fn(),
  getRegisteredTelemetryIntegrations: (options?: { readonly sanitizeEveOtelErrors?: boolean }) =>
    mockGetRegisteredTelemetryIntegrations(options),
}));

let declaredAudience: ChannelAudience = "unknown";
let declaredEnvironment: ConversationEnvironment = "production";
let declaredDecision: InstrumentationDecision | undefined;
let declaredInstrumentation: SessionInstrumentation | undefined;
let declaredRuntime: InstrumentationRuntime | undefined;

function createInstrumentationContext(
  decision: InstrumentationDecision | undefined,
  audience: ChannelAudience,
  environment: ConversationEnvironment = "production",
): ContextContainer {
  const ctx = new ContextContainer();
  setConversationContext(ctx, audience, "channel:test", {}, environment);
  if (decision !== undefined) {
    ctx.set(SessionTraceSeedKey, {
      decision,
      spanId: "1".repeat(16),
      traceFlags: decision.action === "record" ? 1 : 0,
      traceId: "2".repeat(32),
    });
  }
  return ctx;
}

function setConversationContext(
  ctx: ContextContainer,
  audience: ChannelAudience,
  kind: ConversationContext["channel"]["kind"],
  metadata: Readonly<Record<string, unknown>> = {},
  environment: ConversationEnvironment = "production",
): void {
  ctx.set(ChannelInstrumentationKey, { kind, metadata });
  ctx.set(ConversationContextKey, {
    audience,
    channel: { kind, name: "test" },
    environment,
    principalType: "anonymous",
  });
}

function declareTelemetry(
  config:
    | (Readonly<Record<string, unknown>> & {
        readonly runtimeContext?: RuntimeContextResolver;
      })
    | undefined,
  decision?: InstrumentationDecision,
  audience: ChannelAudience = "unknown",
  environment: ConversationEnvironment = "production",
): void {
  declaredAudience = audience;
  declaredEnvironment = environment;
  declaredDecision = decision;
  declaredRuntime =
    config === undefined
      ? undefined
      : {
          forceFlush: async () => undefined,
          hooks: createInstrumentationHooks([]),
          otelSettings: {
            ...config,
            recordInputs: config.recordInputs === true,
            recordOutputs: config.recordOutputs === true,
            traceChannelRequests: config["traceChannelRequests"] === true,
          },
          runtimeContextResolvers:
            config.runtimeContext === undefined ? undefined : [config.runtimeContext],
          runInContext: (_operation, execute) => execute(),
          shutdown: async () => undefined,
        };
  declaredInstrumentation = bindInstrumentationRuntime(
    declaredRuntime,
    createInstrumentationContext(decision, audience, environment),
    {
      agentName: "test-agent",
      rootSessionId: "test-session",
      sessionId: "test-session",
    },
  )?.prepareExecution();
}

function bindHookInstrumentation(
  hooks: ReturnType<typeof createInstrumentationHooks>,
  runInContext: InstrumentationContextRunner = (_operation, execute) => execute(),
  useDeclaredRuntime = false,
): SessionInstrumentation {
  return bindInstrumentationRuntime(
    {
      forceFlush: async () => undefined,
      hooks,
      otelSettings: useDeclaredRuntime ? declaredRuntime?.otelSettings : undefined,
      runtimeContextResolvers: useDeclaredRuntime
        ? declaredRuntime?.runtimeContextResolvers
        : undefined,
      runInContext,
      shutdown: async () => undefined,
    },
    createInstrumentationContext(
      useDeclaredRuntime ? declaredDecision : undefined,
      useDeclaredRuntime ? declaredAudience : "unknown",
      useDeclaredRuntime ? declaredEnvironment : "production",
    ),
    { agentName: "test-agent", rootSessionId: "test-session", sessionId: "test-session" },
  )!.prepareExecution();
}

vi.mock("#harness/compaction/engine.js", () => ({
  compactMessages: vi.fn(),
  estimateTokens: vi.fn().mockReturnValue(5000),
  getInputTokenCount: vi.fn().mockReturnValue(5000),
  shouldCompact: vi.fn().mockReturnValue(false),
}));

/** Compacts to `messages` through one summary call, which {@link summaryCall} reads. */
function mockCompaction(messages: ModelMessage[]): void {
  vi.mocked(streamText).mockReturnValue({
    finishReason: Promise.resolve("stop"),
    fullStream: (async function* () {})(),
    providerMetadata: Promise.resolve(undefined),
    text: Promise.resolve("summary"),
    usage: Promise.resolve({ inputTokens: 10, outputTokens: 2 }),
  } as never);
  vi.mocked(compactMessages).mockImplementation(async (_messages, _config, summarize) => {
    await summarize({ messages: [], system: "" });
    return messages;
  });
}

function summaryCall(): Parameters<typeof streamText>[0] | undefined {
  return vi.mocked(streamText).mock.calls[0]?.[0];
}

afterEach(() => {
  vi.clearAllMocks();
  vi.mocked(shouldCompact).mockReset().mockReturnValue(false);
  vi.mocked(compactMessages).mockReset();
  vi.unstubAllEnvs();
  declareTelemetry(undefined);
  mockGetRegisteredTelemetryIntegrations.mockReset().mockReturnValue([]);
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
  emit?: HarnessEmitFn,
  overrides?: Partial<ToolLoopHarnessConfig>,
): ToolLoopHarnessConfig {
  return {
    capabilities: { requestInput: true },
    // The handler folds what it hears, as the publish sink does for a running session.
    handleEvent: emit === undefined ? undefined : foldingHandler(emit),
    instrumentation: declaredInstrumentation,
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
        workflowId: "workflow//./agent/subagents/researcher//execute",
      },
    ],
  ]);
}

/** Adds the `bash` tool the pending approval fixtures ask to run. */
/** A `task` workflow tool, so the agent can start tasks and gets the task tools. */
function createTaskToolMap(): ToolLoopHarnessConfig["tools"] {
  const workflowId = "workflow//./agent/tools/research//task";
  return new Map([
    [
      "research",
      {
        behavior: {
          availability: [],
          handling: {
            kind: "dispatch",
            target: { entryPoint: "task", kind: "workflow-tool-call", workflowId },
          },
        },
        description: "Research in the background.",
        inputSchema: jsonSchema({ type: "object" }),
        name: "research",
        workflowId,
      },
    ],
  ]);
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
  events: UnstampedMessageStreamEvent[];
} {
  const events: UnstampedMessageStreamEvent[] = [];
  const emit: HarnessEmitFn = async (event) => {
    events.push(event);
  };
  return { emit, events };
}

function getCompatibilityEventTypes(events: readonly UnstampedMessageStreamEvent[]): string[] {
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
  responseMessages: Promise<Record<string, unknown>[]>;
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
    responseMessages: Promise.resolve(getMockResponseMessages(result)),
    steps: Promise.resolve([result]),
  };
}

function getMockResponseMessages(result: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(result.responseMessages)) {
    return result.responseMessages as Array<Record<string, unknown>>;
  }

  const response = (result.response ?? {}) as { messages?: unknown };
  return Array.isArray(response.messages)
    ? (response.messages as Array<Record<string, unknown>>)
    : [];
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
  onStepStart?: (input: unknown) => Promise<void> | void;
  onStepEnd?: (step: unknown) => Promise<void> | void;
  output?: unknown;
  prepareStep?: (input: unknown) => Promise<unknown> | unknown;
};

type MockAgentConstructor =
  ConstructorParameters<typeof ToolLoopAgent> extends [infer S]
    ? (settings: S) => ToolLoopAgent
    : never;
type MockAgentInstance = ToolLoopAgent & Record<string, unknown>;

async function invokeMockStepStart(
  settings: MockAgentSettings,
  options: { readonly messages: unknown[] },
): Promise<void> {
  let preparedMessages = options.messages;
  if (settings.prepareStep) {
    const prepared = await settings.prepareStep({
      messages: options.messages,
      steps: [],
      stepNumber: 0,
      model: {},
      context: undefined,
    });
    if (
      prepared !== null &&
      typeof prepared === "object" &&
      "messages" in prepared &&
      Array.isArray(prepared.messages)
    ) {
      preparedMessages = prepared.messages;
    }
  }
  await settings.onStepStart?.({ messages: preparedMessages });
}

function setupMockAgent(result: Record<string, unknown>): void {
  vi.mocked(ToolLoopAgent).mockImplementation(function (
    this: Record<string, unknown>,
    settings: MockAgentSettings,
  ) {
    const { onStepEnd } = settings;

    this.stream = vi.fn().mockImplementation(async (options: { messages: unknown[] }) => {
      await invokeMockStepStart(settings, options);
      const mockResult = createMockStreamResult(result);
      // Schedule onStepEnd to fire after a microtask so the stream
      // can start being consumed first by emitStreamContent.
      if (onStepEnd) {
        void Promise.resolve().then(() => onStepEnd(result));
      }
      return mockResult;
    });

    return this as unknown as ToolLoopAgent;
  } as unknown as MockAgentConstructor);
}

function setupMockAgentSequence(results: readonly Record<string, unknown>[]): void {
  let index = 0;
  vi.mocked(ToolLoopAgent).mockImplementation(function (
    this: MockAgentInstance,
    settings: MockAgentSettings,
  ) {
    const result = results[index++];
    if (result === undefined) {
      throw new Error("ToolLoopAgent mock exhausted its scripted results.");
    }
    const { onStepEnd } = settings;
    this.stream = vi.fn().mockImplementation(async (options: { messages: unknown[] }) => {
      await invokeMockStepStart(settings, options);
      const mockResult = createMockStreamResult(result);
      if (onStepEnd) void Promise.resolve().then(() => onStepEnd(result));
      return mockResult;
    });
    return this;
  } as MockAgentConstructor);
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
    toolCalls: [{ input: structured, toolCallId: "final-output-1", toolName: "eve__reply" }],
    toolResults: [],
  };
}

/** A step parked on its approvals, as the machine parks one. */
function parkedOnApproval(input: {
  readonly event?: {
    readonly sequence: number;
    readonly stepIndex: number;
    readonly turnId: string;
  };
  readonly requests: Parameters<typeof withParkedStep>[1]["requests"];
  readonly responseAuthRequiredRequestIds?: readonly string[];
  readonly responseMessages: Parameters<typeof withParkedStep>[1]["messages"];
  readonly session: HarnessSession;
}): HarnessSession {
  return withParkedStep(input.session, {
    event: input.event,
    messages: input.responseMessages,
    requests: input.requests,
    responseAuthRequiredRequestIds: input.responseAuthRequiredRequestIds,
  });
}

/** What the session asks and still awaits. */
function setupMockAgentError(error: Error): void {
  vi.mocked(ToolLoopAgent).mockImplementation(function (
    this: Record<string, unknown>,
    _settings: MockAgentSettings,
  ) {
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

const DELEGATED_SPEND = {
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.25,
  inputTokens: 100,
  outputTokens: 20,
};

/** A session whose delegated agents already spent {@link DELEGATED_SPEND}. */
function withDelegatedSpend(overrides?: Parameters<typeof createTestSession>[0]): HarnessSession {
  return countRunUsage(createTestSession(overrides), DELEGATED_SPEND);
}

function lastSessionEvent<T extends "session.waiting" | "session.failed">(
  events: readonly UnstampedMessageStreamEvent[],
  type: T,
): Extract<UnstampedMessageStreamEvent, { type: T }> | undefined {
  return events.findLast(
    (event): event is Extract<UnstampedMessageStreamEvent, { type: T }> => event.type === type,
  );
}

describe("createToolLoopHarness", () => {
  it("reports the session's running usage, delegated spend included, when the turn ends", async () => {
    setupMockAgent({
      finishReason: "stop",
      providerMetadata: { gateway: { cost: "0.125" } },
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
    const { emit, events } = createEventCollector();

    await createToolLoopHarness(createTestConfig(emit))(withDelegatedSpend(), { message: "Hi" });

    expect(lastSessionEvent(events, "session.waiting")?.data.usage).toEqual({
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      costUsd: 0.375,
      inputTokens: 107,
      outputTokens: 23,
    });
  });

  it("reports no session cost on session.waiting when no model call reported one", async () => {
    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "Hello!", role: "assistant" }] },
      text: "Hello!",
      toolCalls: [],
      toolResults: [],
      usage: { inputTokens: 7, outputTokens: 3 },
    });
    const { emit, events } = createEventCollector();

    await createToolLoopHarness(createTestConfig(emit))(createTestSession(), { message: "Hi" });

    expect(lastSessionEvent(events, "session.waiting")?.data.usage).toEqual({
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: undefined,
      inputTokens: 7,
      outputTokens: 3,
    });
  });

  it("reports the session's usage on session.waiting when a failed model call parks the turn", async () => {
    setupMockAgentError(new Error("Model blew up"));
    const { emit, events } = createEventCollector();

    await createToolLoopHarness(createTestConfig(emit))(withDelegatedSpend(), { message: "Hi" });

    expect(lastSessionEvent(events, "session.waiting")?.data.usage).toEqual(DELEGATED_SPEND);
  });

  it("reports the session's usage on session.failed when model selection fails", async () => {
    const emit: HarnessEmitFn = async (event) => {
      events.push(event);
      if (event.type === "turn.started") {
        throw new DynamicModelSelectionError(new Error("flag service unavailable"));
      }
    };
    const events: UnstampedMessageStreamEvent[] = [];

    await createToolLoopHarness(createTestConfig(emit))(
      withDelegatedSpend({ outputSchema: { type: "object" } }),
      { message: "Hi" },
    );

    expect(lastSessionEvent(events, "session.failed")?.data.usage).toEqual(DELEGATED_SPEND);
  });

  it("uses one projected history view for step consumers while preserving raw history", async () => {
    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "Hello!", role: "assistant" }] },
      text: "Hello!",
      toolCalls: [],
      toolResults: [],
      usage: { inputTokens: 123 },
    });

    const hidden = {
      content: "HIDE_FROM_CONSUMERS",
      kind: "user" as const,
      role: "user" as const,
    };
    const projector = vi.fn(({ messages }: { messages: readonly ModelMessage[] }) =>
      messages.filter((message) => message !== hidden),
    );
    const stepEventMessages: Array<readonly ModelMessage[]> = [];
    const handleEvent: HarnessEmitFn = async (event, messages) => {
      if (event.type === "step.started") {
        stepEventMessages.push(messages ?? []);
      }
    };
    const dynamicModelMessages: Array<readonly ModelMessage[]> = [];
    const runStep = createToolLoopHarness(
      createTestConfig(handleEvent, {
        participants: modelParticipants(async ({ messages }) => {
          dynamicModelMessages.push(messages);
        }),
        historyProjector: projector,
      }),
    );
    const session = createTestSession({
      history: [
        { content: "first", kind: "user" as const, role: "user" },
        hidden,
        { content: "second", role: "assistant" },
      ],
    });

    const result = await contextStorage.run(new ContextContainer(), () =>
      runStep(session, { message: "third" }),
    );
    const expectedView = [
      { content: "first", kind: "user" as const, role: "user" },
      { content: "second", role: "assistant" },
      { content: "third", kind: "user" as const, role: "user" },
    ];
    const agent = vi.mocked(ToolLoopAgent).mock.results[0]?.value;

    expect(dynamicModelMessages).toEqual([expectedView]);
    expect(stepEventMessages).toEqual([expectedView]);
    expect(agent.stream).toHaveBeenCalledWith(expect.objectContaining({ messages: expectedView }));
    expect(result.session.history).toEqual([
      { content: "first", kind: "user" as const, role: "user" },
      hidden,
      { content: "second", role: "assistant" },
      { content: "third", kind: "user" as const, role: "user" },
      { content: "Hello!", role: "assistant" },
    ]);
    expect(result.session.compaction).toMatchObject({
      lastKnownInputTokens: 123,
      lastKnownPromptMessageCount: expectedView.length,
    });
    expect(projector.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("stops before lifecycle callbacks and the model when history projection fails", async () => {
    const handleEvent = vi.fn();
    const resolveDynamicModel = vi.fn();
    const runStep = createToolLoopHarness(
      createTestConfig(handleEvent, {
        participants: modelParticipants(resolveDynamicModel),
        historyProjector: () => {
          throw new Error("projection failed");
        },
      }),
    );

    await expect(runStep(createTestSession(), { message: "Hi" })).rejects.toThrow(
      "projection failed",
    );
    expect(handleEvent).not.toHaveBeenCalled();
    expect(resolveDynamicModel).not.toHaveBeenCalled();
    expect(ToolLoopAgent).not.toHaveBeenCalled();
  });

  it("emits settled prose history with turn.completed", async () => {
    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "Hello!", role: "assistant" }] },
      text: "Hello!",
      toolCalls: [],
      toolResults: [],
    });
    const completedHistory: Array<readonly ModelMessage[]> = [];
    const handleEvent: HarnessEmitFn = async (event, messages) => {
      if (event.type === "turn.completed") completedHistory.push(messages ?? []);
    };

    await createToolLoopHarness(createTestConfig(handleEvent))(createTestSession(), {
      message: "Hi",
    });

    expect(completedHistory).toEqual([
      [
        { content: "Hi", kind: "user", role: "user" },
        { content: "Hello!", role: "assistant" },
      ],
    ]);
  });

  it("parks when model finishes with stop", async () => {
    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "Hello!", role: "assistant" }] },
      text: "Hello!",
      toolCalls: [],
      toolResults: [],
    });

    const config = createTestConfig();
    const runStep = createToolLoopHarness(config);
    const session = createTestSession();

    const result = await runStep(session, { message: "Hi" });

    expect(result.next).toBeNull();
    expect(result.session.history).toEqual([
      { content: "Hi", kind: "user" as const, role: "user" },
      { content: "Hello!", role: "assistant" },
    ]);
  });

  it("steers an open turn with a new message without repeating the turn preamble", async () => {
    const toolCall = {
      input: { query: "weather in ny" },
      toolCallId: "call-1",
      toolName: "web_search",
      type: "tool-call",
    };
    const toolResult = { ...toolCall, output: { temperature: "41 F" }, type: "tool-result" };
    setupMockAgentSequence([
      {
        finishReason: "tool-calls",
        response: {
          messages: [
            { content: [toolCall], role: "assistant" },
            { content: [toolResult], role: "tool" },
          ],
        },
        text: "",
        toolCalls: [toolCall],
        toolResults: [toolResult],
      },
      {
        finishReason: "stop",
        response: { messages: [{ content: "It is 41 F in NY.", role: "assistant" }] },
        text: "It is 41 F in NY.",
        toolCalls: [],
        toolResults: [],
      },
    ]);
    const { emit, events } = createEventCollector();
    const config = createTestConfig(emit, {
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

    const first = await runStep(session, { message: "What's the weather in NY?" });
    expect(typeof first.next).toBe("function");
    // Between steps, the open turn's position is the step it last started.
    expect(positionOf(first.session)).toMatchObject({
      turnId: "turn_0",
      stepIndex: 0,
    });

    const second = await runStep(first.session, { message: "Use Fahrenheit." });

    expect(second.next).toBeNull();
    expect(events.filter((event) => event.type === "turn.started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "message.received")).toHaveLength(2);
    expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
    expect(second.session.history.at(-2)).toEqual({
      content: "Use Fahrenheit.",
      kind: "user",
      role: "user",
    });
    expect(positionOf(second.session)).toMatchObject({
      sequence: 1,
      stepIndex: 0,
      turnId: "",
    });
  });

  it("omits user messages with no model-visible content", async () => {
    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "Hello!", role: "assistant" }] },
      text: "Hello!",
      toolCalls: [],
      toolResults: [],
    });

    const runStep = createToolLoopHarness(createTestConfig());
    const blankMessages: Array<string | UserContent> = [
      "",
      " \n\t",
      [{ text: "", type: "text" }],
      [{ text: " \n\t", type: "text" }],
    ];

    for (const message of blankMessages) {
      const result = await runStep(createTestSession(), {
        context: ["channel context"],
        message,
      });

      expect(result.session.history).toEqual([
        { content: "channel context", kind: "context.instruction", role: "user" },
        { content: "Hello!", role: "assistant" },
      ]);
    }
  });

  it("removes blank text blocks from persisted history before the provider call", async () => {
    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "Hello!", role: "assistant" }] },
      text: "Hello!",
      toolCalls: [],
      toolResults: [],
    });

    const runStep = createToolLoopHarness(createTestConfig());
    await runStep(
      createTestSession({
        history: [
          { content: " ", role: "assistant" },
          {
            content: [
              { text: "", type: "text" },
              { text: "Previous reply", type: "text" },
            ],
            role: "assistant",
          },
        ],
      }),
      { message: "Continue" },
    );

    const agent = vi.mocked(ToolLoopAgent).mock.results[0]?.value as {
      stream: ReturnType<typeof vi.fn>;
    };
    expect(agent.stream.mock.calls[0]?.[0].messages).toEqual([
      { content: [{ text: "Previous reply", type: "text" }], role: "assistant" },
      { content: "Continue", kind: "user" as const, role: "user" },
    ]);
  });

  it("keeps executable tools directly available to the model", async () => {
    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "Hello!", role: "assistant" }] },
      text: "Hello!",
      toolCalls: [],
      toolResults: [],
    });

    const config = createTestConfig();
    const runStep = createToolLoopHarness(config);
    const session = createTestSession();

    await runStep(session, { message: "Hi" });

    const agentCall = vi.mocked(ToolLoopAgent).mock.calls[0]?.[0];
    expect(agentCall).toBeDefined();
    expect(agentCall!.tools).toHaveProperty("add");
    expect(agentCall!.tools).not.toHaveProperty("Workflow");
  });

  it.each([undefined, "low", "provider-default"] as const)(
    "uses dynamic model selection and reasoning (%s) for the model call",
    async (reasoning) => {
      setupMockAgent({
        finishReason: "stop",
        response: { messages: [{ content: "Hello!", role: "assistant" }] },
        text: "Hello!",
        toolCalls: [],
        toolResults: [],
      });

      const selectedModel = new MockLanguageModelV3({
        modelId: "gpt-5",
        provider: "openai.chat",
      });
      const resolveModel = vi.fn().mockResolvedValue("fallback-model" as LanguageModel);
      const resolveDynamicModel: StepParticipants["selectModel"] = vi.fn(async ({ messages }) => {
        expect(messages.at(-1)).toEqual({ content: "Hi", kind: "user" as const, role: "user" });

        contextStorage.getStore()!.setVirtualContext(LiveStepDynamicModelSelectionKey, {
          model: selectedModel,
          reference: {
            contextWindowTokens: 200_000,
            id: "openai/gpt-5",
            reasoning,
            providerOptions: { openai: { parallelToolCalls: false } },
          },
        });
      });
      const config = createTestConfig(undefined, {
        participants: modelParticipants(resolveDynamicModel),
        resolveModel,
      });
      const runStep = createToolLoopHarness(config);
      const ctx = new ContextContainer();
      const session = createTestSession({
        agent: {
          dynamicModel: true,
          reasoning: "high",
          system: "You are a test assistant.",
          tools: [{ description: "Adds numbers", name: "add", inputSchema: { type: "object" } }],
        },
        compaction: { recentWindowSize: 10, threshold: 90_000 },
      });

      const result = await contextStorage.run(ctx, () => runStep(session, { message: "Hi" }));

      const agentCall = vi.mocked(ToolLoopAgent).mock.calls[0]?.[0];
      expect(agentCall).toBeDefined();
      expect(agentCall!.model).toBe(selectedModel);
      expect(agentCall!.reasoning).toBe(reasoning ?? "high");
      const prepareStep = getPrepareStep<unknown[], { providerOptions?: unknown }>(
        agentCall!.prepareStep,
      );
      const prepared = await prepareStep({
        context: undefined,
        messages: [],
        model: selectedModel,
        stepNumber: 0,
        steps: [],
      });
      expect(prepared.providerOptions).toEqual({ openai: { parallelToolCalls: false } });
      expect(resolveDynamicModel).toHaveBeenCalledTimes(1);
      expect(resolveModel).not.toHaveBeenCalled();
      expect(result.session.agent.modelReference).toEqual({
        contextWindowTokens: 200_000,
        id: "openai/gpt-5",
        reasoning,
        providerOptions: { openai: { parallelToolCalls: false } },
      });
      expect(result.session.compaction.threshold).toBe(180_000);
    },
  );

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
    const config = createTestConfig(undefined, {
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
        dynamicModel: true,
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

  it("keeps the compaction threshold stable and fails when no dynamic selection remains", async () => {
    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "Hello!", role: "assistant" }] },
      text: "Hello!",
      toolCalls: [],
      toolResults: [],
    });

    const config = createTestConfig(undefined, {
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
        dynamicModel: true,
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
    await expect(
      contextStorage.run(ctx, () => runStep(second.session, { message: "Back" })),
    ).rejects.toThrow(/Dynamic model selection is required/);
  });

  it("passes projected history and incoming input to turn.started on every turn", async () => {
    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "ok", role: "assistant" }] },
      text: "ok",
      toolCalls: [],
      toolResults: [],
    });
    const snapshots: (readonly ModelMessage[] | undefined)[] = [];
    const hidden = { content: "Hidden context", kind: "user" as const, role: "user" as const };
    const runStep = createToolLoopHarness(
      createTestConfig(
        async (event, messages) => {
          if (event.type === "turn.started") snapshots.push(messages);
        },
        {
          historyProjector: ({ messages }) => messages.filter((message) => message !== hidden),
        },
      ),
    );

    const first = await runStep(createTestSession({ history: [hidden] }), { message: "Hello" });
    await runStep(first.session, { context: ["Current context"], message: "Follow up" });

    expect(snapshots).toEqual([
      [{ content: "Hello", kind: "user", role: "user" }],
      [
        { content: "Hello", kind: "user", role: "user" },
        { content: "ok", role: "assistant" },
        { content: "Current context", kind: "context.instruction", role: "user" },
        { content: "Follow up", kind: "user", role: "user" },
      ],
    ]);
  });

  it("emits a terminal failure when no dynamic model selection is active", async () => {
    const logs = captureLogRecords();
    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(createTestConfig(emit));
    const session = createTestSession({
      agent: {
        dynamicModel: true,
        system: "You are a test assistant.",
        tools: [],
      },
    });

    const result = await contextStorage.run(new ContextContainer(), () =>
      runStep(session, { message: "Hi" }),
    );

    expect(result.next).toEqual({ done: true, output: "" });
    expect(events.map((event) => event.type)).toEqual([
      "session.started",
      "turn.started",
      "message.received",
      "step.failed",
      "turn.failed",
      "session.failed",
    ]);
    const turnFailed = events.find((event) => event.type === "turn.failed");
    expect(turnFailed?.data.message).toContain("Dynamic model selection is required");
    expect(ToolLoopAgent).not.toHaveBeenCalled();
    expect(logs.records).toContainEqual(
      expect.objectContaining({ level: "error", message: "model selection failed terminally" }),
    );
  });

  it("emits a terminal failure when a turn-scoped dynamic model resolver throws", async () => {
    const logs = captureLogRecords();
    const events: UnstampedMessageStreamEvent[] = [];
    const emit: HarnessEmitFn = async (event) => {
      events.push(event);
      if (event.type === "turn.started") {
        throw new DynamicModelSelectionError(new Error("flag service unavailable"));
      }
    };
    const runStep = createToolLoopHarness(createTestConfig(emit));

    const result = await runStep(createTestSession({ outputSchema: { type: "object" } }), {
      message: "Hi",
    });

    expect(result.next).toEqual({ done: true, output: "" });
    expect(events.map((event) => event.type)).toEqual([
      "session.started",
      "turn.started",
      "step.failed",
      "turn.failed",
      "session.failed",
    ]);
    const turnFailed = events.find((event) => event.type === "turn.failed");
    expect(turnFailed?.data.message).toBe("flag service unavailable");
    expect(ToolLoopAgent).not.toHaveBeenCalled();
    expect(logs.records).toContainEqual(
      expect.objectContaining({ level: "error", message: "model selection failed terminally" }),
    );
  });

  it("keeps declared subagent tools visible in delegated sessions", async () => {
    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "Hello!", role: "assistant" }] },
      text: "Hello!",
      toolCalls: [],
      toolResults: [],
    });

    const config = createTestConfig(undefined, {
      tools: createDelegationToolMap(),
    });
    const runStep = createToolLoopHarness(config);

    await runStep(createTestSession({ rootSessionId: "root-session" }), {
      message: "Hi",
    });

    const agentCall = vi.mocked(ToolLoopAgent).mock.calls[0]?.[0];
    expect(agentCall).toBeDefined();
    expect(agentCall!.tools).toHaveProperty("add");
    expect(agentCall!.tools).toHaveProperty("delegate");
  });

  it("publishes declared subagent calls from nested sessions", async () => {
    setupMockAgent({
      finishReason: "tool-calls",
      response: {
        messages: [
          {
            content: [
              {
                input: { message: "delegate from child" },
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
          input: { message: "delegate from child" },
          toolCallId: "call-1",
          toolName: "delegate",
          type: "tool-call",
        },
      ],
      toolResults: [],
    });

    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(
      createTestConfig(emit, { tools: createDelegationToolMap() }),
    );

    const result = await runStep(createTestSession({ rootSessionId: "root-session" }), {
      message: "Hi",
    });

    expect(events.find((event) => event.type === "actions.requested")?.data.actions).toEqual([
      expect.objectContaining({
        callId: "call-1",
        input: { message: "delegate from child" },
        kind: "tool-call",
        toolName: "delegate",
      }),
    ]);
    expect(runtimeWait(result.session.state)?.tasks).toEqual([
      expect.objectContaining({
        callId: "call-1",
        input: { message: "delegate from child" },
        kind: "workflow-task",
        toolName: "delegate",
      }),
    ]);
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

  it("accumulates provider-reported token usage and cost across the session", async () => {
    setupMockAgent({
      finishReason: "stop",
      providerMetadata: { gateway: { cost: "0.0123" } },
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
      costUsd: 0.0123,
      inputTokens: 7,
      outputTokens: 3,
      sawCost: true,
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
      errorCode: "SESSION_TOKEN_LIMIT_REACHED",
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
      errorCode: "SESSION_TOKEN_LIMIT_REACHED",
      tokenKind: "output",
    },
    {
      details: {
        costUsd: 1.51,
        kind: "token-cost",
        limitUsd: 1.5,
        usedCostUsd: 1.51,
      },
      message: "The session reached its configured model token-cost limit.",
      limits: {
        maxTokenCostUsdPerSession: 1.5,
      },
      usage: {
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        costUsd: 1.51,
        inputTokens: 7,
        outputTokens: 3,
        sawCost: true,
      },
      errorCode: "SESSION_TOKEN_COST_LIMIT_REACHED",
      tokenKind: "model token-cost",
    },
  ])(
    "fails fast after the $tokenKind limit when the session cannot request input",
    async (testCase) => {
      const { emit, events } = createEventCollector();
      const runStep = createToolLoopHarness(createTestConfig(emit, { capabilities: undefined }));
      const session = setTurnUsageState(createTestSession({ limits: testCase.limits }), {
        turnId: "turn_previous",
        ...testCase.usage,
        session: testCase.usage,
      });

      const result = await runStep(session, { message: "Hi again" });

      expect(vi.mocked(ToolLoopAgent)).not.toHaveBeenCalled();
      expect(result.next).toEqual({ done: true, output: "" });
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
        code: testCase.errorCode,
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

  const LIMIT_REQUEST_ID = "test-session:0:limit:input:12";

  it("parks on a deterministic continuation prompt when the session reaches its token limit", async () => {
    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(createTestConfig(emit));

    const result = await runStep(createLimitReachedSession(), { message: "Hi again" });

    expect(vi.mocked(ToolLoopAgent)).not.toHaveBeenCalled();
    expect(result.next).toBeNull();
    expect(result.settledTurn).toBeUndefined();
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
          kind: "session-limit",
          options: [
            { id: "continue", label: "Approve", style: "primary" },
            { id: "stop", label: "Stop", style: "danger" },
          ],
          requestId: LIMIT_REQUEST_ID,
        },
      ],
    });
  });

  it("parks and grants a fresh model token-cost budget", async () => {
    const usage = {
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 1.51,
      inputTokens: 12,
      outputTokens: 3,
      sawCost: true,
    };
    const reached = setTurnUsageState(
      createTestSession({ limits: { maxTokenCostUsdPerSession: 1.5 } }),
      { turnId: "turn_previous", ...usage, session: usage },
    );
    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(createTestConfig(emit));

    const parked = await runStep(reached, { message: "Hi again" });
    expect(events.find((event) => event.type === "input.requested")?.data).toMatchObject({
      requests: [
        {
          action: {
            input: { kind: "token-cost", limitUsd: 1.5, usedCostUsd: 1.51 },
          },
          prompt: expect.stringContaining("$1.5 model token-cost limit"),
          requestId: "test-session:0:limit:token-cost:1.51",
        },
      ],
    });

    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "Hello!", role: "assistant" }] },
      text: "Hello!",
      toolCalls: [],
      toolResults: [],
    });
    const resumed = await runStep(parked.session, {
      inputResponses: [{ optionId: "continue", requestId: "test-session:0:limit:token-cost:1.51" }],
    });

    expect(vi.mocked(ToolLoopAgent)).toHaveBeenCalledTimes(1);
    expect(getSessionUsageLimitViolation(resumed.session)).toBeNull();
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
    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(createTestConfig(emit));

    const parked = await runStep(createLimitReachedSession(), { message: "Hi again" });
    expect(vi.mocked(ToolLoopAgent)).not.toHaveBeenCalled();

    const resumed = await runStep(parked.session, {
      inputResponses: [{ optionId: "continue", requestId: LIMIT_REQUEST_ID }],
    });

    expect(vi.mocked(ToolLoopAgent)).toHaveBeenCalledTimes(1);
    expect(resumed.next).toBeNull();
    expect(getSessionUsageLimitViolation(resumed.session)).toBeNull();
    // The parked user message survives into model history for the resumed call.
    expect(resumed.session.history).toContainEqual({
      content: "Hi again",
      kind: "user" as const,
      role: "user",
    });
    const resolutionIndex = events.findIndex((event) => event.type === "input.resolved");
    expect(resolutionIndex).toBeGreaterThan(-1);
    expect(events[resolutionIndex]).toMatchObject({
      data: {
        resolutions: [
          {
            kind: "session-limit",
            outcome: "answered",
            requestId: LIMIT_REQUEST_ID,
            response: { optionId: "continue", requestId: LIMIT_REQUEST_ID },
          },
        ],
      },
      type: "input.resolved",
    });
    expect(
      events.findIndex((event, index) => index > resolutionIndex && event.type === "step.started"),
    ).toBeGreaterThan(resolutionIndex);
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
    const runStep = createToolLoopHarness(createTestConfig(emit));

    const parked = await runStep(createLimitReachedSession(), { message: "Hi again" });

    // Surfaces without buttons deliver the answer as a plain message;
    // resolveTextToResponses maps it onto the pending option.
    const resumed = await runStep(parked.session, { message: "continue" });

    expect(vi.mocked(ToolLoopAgent)).toHaveBeenCalledTimes(1);
    expect(resumed.next).toBeNull();
    expect(getSessionUsageLimitViolation(resumed.session)).toBeNull();
  });

  it("cancels the turn when the user declines the limit continuation prompt", async () => {
    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(createTestConfig(emit));

    const parked = await runStep(createLimitReachedSession(), { message: "Hi again" });
    const declined = runStep(parked.session, {
      inputResponses: [{ optionId: "stop", requestId: LIMIT_REQUEST_ID }],
    });

    // A decline is a user decision, not an error: the harness declares
    // intent by throwing the decline-flavored cancellation, which the
    // execution layer settles as `turn.cancelled` → `session.waiting` (and,
    // for delegated sessions, escalates to a root-turn cancel). No failure
    // or completion events are emitted here.
    await expect(declined).rejects.toBeInstanceOf(SessionLimitDeclinedError);
    expect(vi.mocked(ToolLoopAgent)).not.toHaveBeenCalled();
    expect(events.some((event) => event.type.endsWith(".failed"))).toBe(false);
    expect(events.some((event) => event.type === "session.completed")).toBe(false);
  });

  it("fails a zero-budget session instead of raising a continuation that cannot grant tokens", async () => {
    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(createTestConfig(emit));
    const session = createTestSession({ limits: { maxInputTokensPerSession: 0 } });

    const result = await runStep(session, { message: "Hi again" });

    expect(vi.mocked(ToolLoopAgent)).not.toHaveBeenCalled();
    expect(result.next).toEqual({ done: true, output: "" });
    expect(events.some((event) => event.type === "input.requested")).toBe(false);
  });

  it("keeps one limit prompt pending when the user replies without answering it", async () => {
    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "Hello!", role: "assistant" }] },
      text: "Hello!",
      toolCalls: [],
      toolResults: [],
      usage: { inputTokens: 7, outputTokens: 3 },
    });
    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(createTestConfig(emit));

    const parked = await runStep(createLimitReachedSession(), { message: "Hi again" });
    const beforeQueued = events.length;
    const reparked = await runStep(parked.session, { message: "also do this other thing" });

    // The message is received into a real turn, which holds for the prompt.
    expect(events.slice(beforeQueued).map((event) => event.type)).toEqual([
      "turn.started",
      "message.received",
      "turn.waiting",
    ]);
    const waiting = events.at(-1);
    expect(waiting).toMatchObject({ data: { on: "input" }, type: "turn.waiting" });
    const turnId = waiting?.type === "turn.waiting" ? waiting.data.turnId : undefined;
    expect(turnId).toMatch(/^turn_/);
    expect(reparked.held).toEqual({ kind: "request" });
    expect(vi.mocked(ToolLoopAgent)).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === "input.requested")).toHaveLength(1);
    const asked = { content: "also do this other thing", kind: "user" as const, role: "user" };
    expect(reparked.session.history).toContainEqual(asked);

    const beforeGrant = events.length;
    const resumed = await runStep(reparked.session, {
      inputResponses: [{ optionId: "continue", requestId: LIMIT_REQUEST_ID }],
    });

    // The grant resumes that turn; the message was received once, and the model reads it once.
    const resumedEvents = events.slice(beforeGrant);
    expect(resumedEvents.some((event) => event.type === "turn.started")).toBe(false);
    expect(resumedEvents.some((event) => event.type === "message.received")).toBe(false);
    expect(resumedEvents.find((event) => event.type === "step.started")?.data.turnId).toBe(turnId);
    expect(vi.mocked(ToolLoopAgent)).toHaveBeenCalledTimes(1);
    expect(
      resumed.session.history.filter((message) => message.content === asked.content),
    ).toHaveLength(1);
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

  it("emits result.completed when a run output schema is requested", async () => {
    const schema = {
      properties: { title: { type: "string" } },
      required: ["title"],
      type: "object",
    } as const;
    setupMockAgent(finalOutputResult("Here is the summary.", { title: "Done" }));

    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(createTestConfig(emit));
    const session = createTestSession({ outputSchema: schema });

    const result = await runStep(session, { message: "Hi" });

    expect(result.next).toBeNull();
    expect(result.settledTurn).toEqual({ output: { title: "Done" } });
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
      { content: "Hi", kind: "user" as const, role: "user" },
      { content: '{"title":"Done"}', role: "assistant" },
    ]);
    expect(result.session.outputSchema).toBeUndefined();
    expect(vi.mocked(ToolLoopAgent).mock.calls[0]?.[0]).toMatchObject({
      tools: expect.objectContaining({ eve__reply: expect.anything() }),
    });
  });

  it("does not offer final_output when no schema is in effect", async () => {
    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "Hello!", role: "assistant" }] },
      text: "Hello!",
      toolCalls: [],
      toolResults: [],
    });

    const config = createTestConfig();
    const runStep = createToolLoopHarness(config);
    const session = createTestSession();

    await runStep(session, { message: "Hi" });

    expect(vi.mocked(ToolLoopAgent).mock.calls).toHaveLength(1);
    expect(vi.mocked(ToolLoopAgent).mock.calls[0]?.[0]).not.toMatchObject({
      tools: expect.objectContaining({ eve__reply: expect.anything() }),
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
                toolName: "eve__reply",
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
        { input: { title: "Done" }, toolCallId: "final-output-1", toolName: "eve__reply" },
      ],
      toolResults: [{ toolCallId: "add-1", toolName: "add", output: "42" }],
    });

    const config = createTestConfig();
    const runStep = createToolLoopHarness(config);
    const session = createTestSession({ outputSchema: schema });

    const result = await runStep(session, { message: "Hi" });

    expect(result.next).toBeNull();
    expect(result.settledTurn).toEqual({ output: { title: "Done" } });
    // The un-executed final_output call is never persisted, so no dangling
    // tool_use survives into history.
    expect(result.session.history).toEqual([
      { content: "Hi", kind: "user" as const, role: "user" },
      { content: '{"title":"Done"}', role: "assistant" },
    ]);
    expect(result.session.outputSchema).toBeUndefined();
  });

  describe("endsTurn tools", () => {
    const reacted = { type: "text", value: "reacted" } as const;
    const tools = new Map([
      ...createTestConfig().tools,
      [
        "react",
        {
          description: "Reacts to the message.",
          endsTurn: true,
          execute: vi.fn().mockResolvedValue("reacted"),
          inputSchema: jsonSchema({ type: "object" }),
          name: "react",
        },
      ],
    ]);

    function stepCalling(
      calls: readonly {
        readonly executeOutput?: unknown;
        readonly name: string;
        readonly output: { readonly type: "error-text" | "text"; readonly value: string };
      }[],
    ): Record<string, unknown> {
      const toolCalls = calls.map((call, index) => ({
        input: {},
        toolCallId: `call-${index}`,
        toolName: call.name,
      }));
      return {
        finishReason: "tool-calls",
        response: {
          messages: [
            {
              content: [
                { text: "Reacting now.", type: "text" },
                ...toolCalls.map((toolCall) => ({ ...toolCall, type: "tool-call" })),
              ],
              role: "assistant",
            },
            {
              content: calls.map((call, index) => ({
                output: call.output,
                toolCallId: `call-${index}`,
                toolName: call.name,
                type: "tool-result",
              })),
              role: "tool",
            },
          ],
        },
        text: "Reacting now.",
        toolCalls,
        toolResults: calls.flatMap((call, index) =>
          call.output.type === "error-text"
            ? []
            : [
                {
                  input: {},
                  output: call.executeOutput ?? call.output.value,
                  toolCallId: `call-${index}`,
                  toolName: call.name,
                },
              ],
        ),
      };
    }

    function toolsWithReactEndsTurn(endsTurn: (output: unknown) => boolean | Promise<boolean>) {
      return new Map([...tools, ["react", { ...tools.get("react")!, endsTurn }]]);
    }

    it("ends the turn without a reply when every call in the step ends the turn", async () => {
      setupMockAgent(stepCalling([{ name: "react", output: reacted }]));
      const { emit, events } = createEventCollector();
      const runStep = createToolLoopHarness(createTestConfig(emit, { tools }));

      const result = await runStep(createTestSession(), { message: "Thanks, that fixed it!" });

      expect(result.next).toBeNull();
      expect(result.settledTurn).toEqual({ output: "" });
      // The narration before the call stays interim, so no channel posts it.
      expect(
        events.flatMap((event) =>
          event.type === "message.completed" ? [event.data.finishReason] : [],
        ),
      ).toEqual(["tool-calls"]);
      expect(getCompatibilityEventTypes(events).slice(-2)).toEqual([
        "turn.completed",
        "session.waiting",
      ]);
      expect(result.session.history.at(-1)).toMatchObject({ role: "tool" });
    });

    it.each([
      {
        calls: [{ name: "react", output: { type: "error-text", value: "Reaction rejected." } }],
        case: "the call fails",
      },
      {
        calls: [
          { name: "react", output: reacted },
          { name: "add", output: { type: "text", value: "42" } },
        ],
        case: "another tool shares the step",
      },
      {
        calls: [{ name: "react", output: reacted }],
        case: "the session is delegated",
        delegated: true,
      },
      {
        calls: [{ name: "react", output: reacted }],
        case: "the turn requests structured output",
        outputSchema: { properties: {}, type: "object" },
      },
    ] as const)("continues the turn when $case", async ({ calls, ...options }) => {
      setupMockAgent(stepCalling(calls));
      const runStep = createToolLoopHarness(createTestConfig(undefined, { tools }));
      const ctx = new ContextContainer();
      if ("delegated" in options) setDelegatedParent(ctx);
      const outputSchema = "outputSchema" in options ? options.outputSchema : undefined;

      const result = await contextStorage.run(ctx, () =>
        runStep(createTestSession({ outputSchema }), { message: "Thanks, that fixed it!" }),
      );

      expect(result.next).toBe(runStep);
      expect(result.settledTurn).toBeUndefined();
    });

    it.each([
      {
        case: "a root session",
        description:
          "Reacts to the message.\n\nCalling this tool ends your turn once it succeeds: do not write a reply or call other tools in the same step. If it fails, you will see the error and can continue.",
      },
      { case: "a delegated session", delegated: true, description: "Reacts to the message." },
      {
        case: "a structured-output turn",
        description: "Reacts to the message.",
        outputSchema: { properties: {}, type: "object" },
      },
      { case: "an endsTurn function", description: "Reacts to the message.", endsTurnFn: true },
    ] as const)("appends the turn-ending note only for endsTurn: true: $case", async (row) => {
      setupMockAgent({
        finishReason: "stop",
        response: { messages: [{ content: "Glad it helped!", role: "assistant" }] },
        text: "Glad it helped!",
        toolCalls: [],
        toolResults: [],
      });
      const runStep = createToolLoopHarness(
        createTestConfig(undefined, {
          tools: "endsTurnFn" in row ? toolsWithReactEndsTurn(() => true) : tools,
        }),
      );
      const ctx = new ContextContainer();
      if ("delegated" in row) setDelegatedParent(ctx);
      const outputSchema = "outputSchema" in row ? row.outputSchema : undefined;

      await contextStorage.run(ctx, () =>
        runStep(createTestSession({ outputSchema }), { message: "Thanks, that fixed it!" }),
      );

      const agentTools = vi.mocked(ToolLoopAgent).mock.calls[0]?.[0]?.tools;
      expect(agentTools?.react?.description).toBe(row.description);
      expect(agentTools?.add?.description).toBe("Adds numbers");
    });
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
    const runStep = createToolLoopHarness(createTestConfig(emit));
    const session = createTestSession({ outputSchema: { type: "object" } });

    const result = await runStep(session, { message: "Hi" });

    expect(result.next).toBeNull();
    expect(result.settledTurn).toEqual({
      isError: true,
      output: "The agent could not produce a result matching the requested schema.",
    });
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
    expect(result.session.outputSchema).toBeUndefined();
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

    const config = createTestConfig();
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

    const config = createTestConfig(undefined, {
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
    expect(result.settledTurn).toEqual({
      output: "It is 41 F in New York right now.",
    });
    expect(result.session.history).toEqual([
      { content: "What's the weather in NY?", kind: "user" as const, role: "user" },
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

    const config = createTestConfig(undefined, {
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
      { content: "What's the weather in NY?", kind: "user" as const, role: "user" },
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

    const config = createTestConfig();
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

    const config = createTestConfig();
    const runStep = createToolLoopHarness(config);
    const session = createTestSession({
      history: [{ content: "prior message", kind: "user" as const, role: "user" }],
    });

    const result = await runStep(session);

    expect(result.next).toBeNull();
    expect(result.settledTurn).toEqual({ output: "The result is 42." });
    expect(result.session.history).toEqual([
      { content: "prior message", kind: "user" as const, role: "user" },
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

    const config = createTestConfig();
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
    const runStep = createToolLoopHarness(createTestConfig(emit));

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
    const runStep = createToolLoopHarness(createTestConfig(emit));

    // A continuation step runs inside the turn an earlier step opened.
    await runStep(
      withOpenTurn(
        createTestSession({ history: [{ content: "prior", kind: "user" as const, role: "user" }] }),
        { sequence: 0, stepIndex: 0, turnId: "turn_0" },
      ),
    );

    expect(getCompatibilityEventTypes(events)).toEqual([
      "step.started",
      "message.completed",
      "step.completed",
      "turn.completed",
      "session.waiting",
    ]);
  });

  it.each(["", "Alice's inventory list is"])(
    "reports content-filter without retrying (text: %j)",
    async (text) => {
      const logs = captureLogRecords();
      setupMockAgent({
        finishReason: "content-filter",
        providerMetadata: {
          gateway: { generationId: "gen_filtered", privateDetail: "not-for-clients" },
        },
        response: { messages: text === "" ? [] : [{ content: text, role: "assistant" }] },
        text,
        toolCalls: [],
        toolResults: [],
      });
      const { emit, events } = createEventCollector();
      const result = await createToolLoopHarness(createTestConfig(emit))(createTestSession(), {
        message: "Help Alice prepare Bob's inventory list.",
      });

      expect(ToolLoopAgent).toHaveBeenCalledTimes(1);
      expect(events.find((event) => event.type === "step.failed")).toMatchObject({
        data: {
          code: "MODEL_CALL_FAILED",
          message: "The model provider filtered this response.",
          details: {
            finishReason: "content-filter",
            generationId: "gen_filtered",
            semanticErrorId: "model-response-content-filtered",
          },
        },
      });
      expect(
        events.some(
          (event) =>
            event.type === "step.completed" ||
            event.type === "turn.completed" ||
            event.type === "message.completed",
        ),
      ).toBe(false);
      expect(JSON.stringify(events.filter((event) => event.type === "step.failed"))).not.toContain(
        "not-for-clients",
      );
      expect(result.next).toBeNull();
      expect(events.some((event) => event.type === "session.waiting")).toBe(true);
      expect(logs.records).toContainEqual(
        expect.objectContaining({
          level: "error",
          message: "model call failed — parking session for retry by the user",
        }),
      );
    },
  );

  it("throws a distinct content-filter error without reissue", async () => {
    setupMockAgent({
      finishReason: "content-filter",
      providerMetadata: { gateway: { generationId: "gen_filtered" } },
      response: { messages: [] },
      text: "",
      toolCalls: [],
      toolResults: [],
    });
    await expect(
      createToolLoopHarness(createTestConfig())(createTestSession(), {
        message: "Help Alice prepare Bob's inventory list.",
      }),
    ).rejects.toMatchObject({
      name: "ContentFilteredModelResponseError",
      message: "The model provider filtered this response.",
      generationId: "gen_filtered",
    });
    expect(ToolLoopAgent).toHaveBeenCalledTimes(1);
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
    const runStep = createToolLoopHarness(createTestConfig(emit));

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
    const invalidInput = '"not an object"';
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
    const runStep = createToolLoopHarness(createTestConfig(emit));
    const firstStep = await runStep(createTestSession(), { message: "Add these" });

    expect(firstStep.next).toBe(runStep);
    expect(firstStep.session.history).toEqual([
      { content: "Add these", kind: "user" as const, role: "user" },
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
    const config = createTestConfig(emit, {
      tools: new Map([
        [
          "delegate",
          {
            description: "Delegate to a subagent.",
            inputSchema: jsonSchema({ type: "object" }),
            name: "delegate",
            workflowId: "workflow//./agent/subagents/researcher//execute",
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

  it("stamps live emission state onto a parked coordination batch so resume is a continuation", async () => {
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
    const config = createTestConfig(emit, {
      tools: new Map([
        [
          "delegate",
          {
            description: "Delegate to a subagent.",
            inputSchema: jsonSchema({ type: "object" }),
            name: "delegate",
            workflowId: "workflow//./agent/subagents/researcher//execute",
          },
        ],
      ]),
    });

    const runStep = createToolLoopHarness(config);
    const result = await runStep(createTestSession(), { message: "Go" });

    // Parked on the runtime call.
    expect(result.next).toBeNull();
    expect(runtimeWait(result.session.state)?.callIds).toEqual(["call-subagent"]);

    // The turn stays open across the park, so the resume is a continuation, not a fresh turn.
    const position = positionOf(result.session);
    expect(position.turnId).toBe("turn_0");
    expect(position.stepIndex).toBe(0);
    expect(position.sessionStarted).toBe(true);
  });

  it("propagates streamed cancellation without waiting for onStepEnd or emitting failures", async () => {
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
      createTestConfig(emit, { abortSignal: abortController.signal }),
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
      return this;
    } as MockAgentConstructor);

    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(
      createTestConfig(emit, { abortSignal: abortController.signal }),
    );

    await expect(runStep(createTestSession(), { message: "Hi" })).rejects.toBe(cancellation);
    expect(streamMock).toHaveBeenCalledTimes(1);

    const eventTypes = events.map((event) => event.type);
    expect(eventTypes).not.toContain("step.failed");
    expect(eventTypes).not.toContain("turn.failed");
    expect(eventTypes).not.toContain("session.failed");
  });

  it("retries a model call after an undici body timeout", async () => {
    const logs = captureLogRecords();
    vi.useFakeTimers();
    const timeout = new TypeError("terminated", {
      cause: Object.assign(new Error("Body Timeout Error"), {
        code: "UND_ERR_BODY_TIMEOUT",
      }),
    });
    const success = {
      finishReason: "stop",
      response: { messages: [{ content: "Recovered", role: "assistant" }] },
      text: "Recovered",
      toolCalls: [],
      toolResults: [],
    };
    const modelCallMock = vi.fn();

    vi.mocked(ToolLoopAgent).mockImplementation(function (
      this: ToolLoopAgent,
      settings: MockAgentSettings,
    ) {
      const { onStepEnd, prepareStep } = settings;
      this.stream = modelCallMock.mockImplementation(async (options: { messages: unknown[] }) => {
        if (prepareStep) {
          await prepareStep({
            context: undefined,
            messages: options.messages,
            model: {},
            stepNumber: 0,
            steps: [],
          });
        }
        if (modelCallMock.mock.calls.length === 1) {
          throw timeout;
        }
        if (onStepEnd) {
          void Promise.resolve().then(() => onStepEnd(success));
        }
        return createMockStreamResult(success);
      });
      return this;
    } as MockAgentConstructor);

    try {
      const runStep = createToolLoopHarness(createTestConfig());
      const pending = runStep(createTestSession(), { message: "Hi" });
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(modelCallMock).toHaveBeenCalledTimes(2);
      expect(result.session.history).toEqual([
        { content: "Hi", kind: "user" as const, role: "user" },
        { content: "Recovered", role: "assistant" },
      ]);
    } finally {
      vi.useRealTimers();
    }
    expect(logs.records).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "model call failed transiently — retrying",
      }),
    );
  });

  it("feeds malformed provider web search input back to the model", async () => {
    const invalidInput = '{"query": 2025 NBA Finals champion}';
    setupMockAgent({
      content: [
        {
          input: invalidInput,
          providerExecuted: true,
          toolCallId: "search-malformed",
          toolName: "web_search",
          type: "tool-call",
        },
      ],
      finishReason: "tool-calls",
      fullStreamParts: [
        {
          input: invalidInput,
          providerExecuted: true,
          toolCallId: "search-malformed",
          toolName: "web_search",
          type: "tool-call",
        },
        { finishReason: "tool-calls", type: "finish-step" },
      ],
      response: {
        messages: [
          {
            content: [
              {
                input: invalidInput,
                providerExecuted: true,
                toolCallId: "search-malformed",
                toolName: "web_search",
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
          providerExecuted: true,
          toolCallId: "search-malformed",
          toolName: "web_search",
          type: "tool-call",
        },
      ],
      toolResults: [],
    });

    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(
      createTestConfig(emit, {
        tools: new Map(),
      }),
    );
    const session = createTestSession({
      agent: {
        modelReference: { id: "anthropic/claude-opus-5" },
        system: "You are a test assistant.",
        tools: [{ description: "Search the web", inputSchema: null, name: "web_search" }],
      },
    });
    const firstStep = await runStep(session, {
      message: "Who won the 2025 NBA Finals?",
    });

    expect(firstStep.next).toBe(runStep);
    expect(events.filter((event) => event.type === "action.result")).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          error: expect.objectContaining({
            message: expect.stringMatching(
              /Failed to parse tool-call arguments for "web_search" \(search-malformed\):/u,
            ),
          }),
          status: "failed",
        }),
        type: "action.result",
      }),
    ]);
    const failedToolMessage = firstStep.session.history.at(-1);
    expect(failedToolMessage).toMatchObject({
      content: [
        {
          output: {
            type: "error-text",
            value: expect.stringMatching(
              /Failed to parse tool-call arguments for "web_search" \(search-malformed\):/u,
            ),
          },
          toolCallId: "search-malformed",
          toolName: "web_search",
          type: "tool-result",
        },
      ],
      role: "tool",
    });
    expect(JSON.stringify(failedToolMessage)).not.toContain("Expected a JSON-serializable object.");

    setupMockAgent({
      finishReason: "stop",
      response: {
        messages: [{ content: "I'll fix the search arguments.", role: "assistant" }],
      },
      text: "I'll fix the search arguments.",
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
  });

  it("does not start a model call when the turn signal is already aborted", async () => {
    const abortController = new AbortController();
    const cancellation = new TurnCancelledError();
    abortController.abort(cancellation);

    const streamMock = vi.fn();
    vi.mocked(ToolLoopAgent).mockImplementation(function (this: ToolLoopAgent) {
      this.stream = streamMock;
      return this;
    } as MockAgentConstructor);

    const { emit } = createEventCollector();
    const runStep = createToolLoopHarness(
      createTestConfig(emit, { abortSignal: abortController.signal }),
    );

    await expect(runStep(createTestSession(), { message: "Hi" })).rejects.toBe(cancellation);
    expect(streamMock).not.toHaveBeenCalled();
  });

  it("emits a recoverable failure cascade and parks the session on a non-terminal model-call error", async () => {
    const logs = captureLogRecords();
    setupMockAgentError(new Error("Model blew up"));

    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(createTestConfig(emit));

    const result = await runStep(createTestSession(), { message: "Hi" });

    // A plain Error defaults to the recoverable classification — the
    // session parks (`next: null`) so the user can follow up in the
    // same thread rather than the whole run being torn down.
    expect(result.next).toBeNull();
    expect(result.settledTurn).toEqual({
      isError: true,
      output: "Model blew up",
    });
    expect(result.session.outputSchema).toBeUndefined();

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
    expect(logs.records).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: "model call failed — parking session for retry by the user",
      }),
    );
  });

  it.each([
    {
      message: "AI Gateway requires a valid credit card on file to service requests.",
      hint: "Add a valid credit card or credits",
    },
    {
      message: "Model call failed: Free tier users do not have access to this model.",
      hint: "Switch to a model available on the free tier",
    },
    {
      message: "Model call failed: Free tier requests on this model are rate-limited.",
      hint: "Wait for the free-tier limit to reset",
    },
  ])(
    "parks the session for the recoverable AI Gateway error: $message",
    async ({ message, hint }) => {
      const logs = captureLogRecords();
      setupMockAgentError(
        Object.assign(new Error(message), {
          name: "GatewayInvalidRequestError",
          statusCode: 403,
          type: "invalid_request_error",
        }),
      );

      const { emit, events } = createEventCollector();
      const runStep = createToolLoopHarness(createTestConfig(emit));

      const result = await runStep(createTestSession(), { message: "Hi" });

      expect(result.next).toBeNull();
      expect(result.settledTurn).toEqual({
        isError: true,
        output: expect.stringContaining(hint),
      });
      expect(events.map((event) => event.type)).toContain("session.waiting");
      expect(events.map((event) => event.type)).not.toContain("session.failed");
      expect(logs.records).toContainEqual(
        expect.objectContaining({
          level: "error",
          message: "model call failed — parking session for retry by the user",
        }),
      );
    },
  );

  it("parks the session on an ambiguous GatewayInternalServerError 400 model-call error", async () => {
    const logs = captureLogRecords();
    setupMockAgentError(
      createGatewayModelCallError({
        gatewayName: "GatewayInternalServerError",
        gatewayType: "internal_server_error",
        upstreamType: "internal_server_error",
      }),
    );

    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(createTestConfig(emit));

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
    expect(logs.records).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: "AI Gateway rejected the model request before the agent produced a response.",
      }),
    );
  });

  it("emits the full terminal failure cascade on a structural 4xx model-call error", async () => {
    const logs = captureLogRecords();
    // 400/401/403/404 responses are classified as terminal — the
    // session is torn down because retrying would hit the same wall.
    const error = Object.assign(new Error("invalid api key"), {
      name: "AI_APICallError",
      statusCode: 401,
    });
    setupMockAgentError(error);

    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(createTestConfig(emit));

    const result = await runStep(createTestSession(), { message: "Hi" });

    expect(result.next).toEqual({ done: true, output: "" });

    const types = events.map((e) => e.type);
    expect(types).toContain("step.failed");
    expect(types).toContain("turn.failed");
    expect(types).toContain("session.failed");
    expect(types).not.toContain("session.waiting");
    expect(logs.records).toContainEqual(
      expect.objectContaining({ level: "error", message: "invalid api key" }),
    );
  });

  it("surfaces a terminal model-call error to a delegated conversation caller", async () => {
    const logs = captureLogRecords();
    const error = Object.assign(new Error("No endpoints found for anthropic/claude-3.5-haiku"), {
      name: "AI_APICallError",
      statusCode: 404,
    });
    setupMockAgentError(error);

    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(createTestConfig(emit));
    const ctx = new ContextContainer();
    setDelegatedParent(ctx);

    const result = await contextStorage.run(ctx, () =>
      runStep(createTestSession(), { message: "Delegated turn" }),
    );

    expect(result.next).toMatchObject({
      done: true,
      isError: true,
      output: expect.stringContaining("No endpoints found for anthropic/claude-3.5-haiku"),
    });

    const types = events.map((e) => e.type);
    expect(types).toContain("step.failed");
    expect(types).toContain("turn.failed");
    expect(types).toContain("session.failed");
    expect(logs.records).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: "No endpoints found for anthropic/claude-3.5-haiku",
      }),
    );
  });

  it("parks a delegated turn held by its working tasks with turn.waiting", async () => {
    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "Checking now.", role: "assistant" }] },
      text: "Checking now.",
      toolCalls: [],
      toolResults: [],
    });
    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(createTestConfig(emit));
    const ctx = new ContextContainer();
    setDelegatedParent(ctx);
    const { table } = createTask(
      { tasks: [] },
      { callId: "call-task", kind: "tool", name: "research", resumable: false, turnId: "turn_0" },
    );

    const result = await contextStorage.run(ctx, () =>
      runStep(writeTaskTable(createTestSession(), table), { message: "Delegated turn" }),
    );

    expect(result.held).toBeDefined();
    expect(events).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({ finishReason: "tool-calls", message: "Checking now." }),
        type: "message.completed",
      }),
    );
    expect(events.at(-1)).toEqual({
      data: { on: "tasks", sequence: 0, turnId: "turn_0", usage: expect.any(Object) },
      type: "turn.waiting",
    });
    expect(events.map((event) => event.type)).not.toContain("session.waiting");
  });

  const REPLY_BEFORE_RESULT = "If the person should hear from you now";
  const WAIT_INSTEAD_OF_REPLYING = "Only your final reply reaches your caller.";

  it.each([
    {
      absent: WAIT_INSTEAD_OF_REPLYING,
      delegated: false,
      guidance: REPLY_BEFORE_RESULT,
      session: "a root session, where a person reads each reply",
    },
    {
      absent: REPLY_BEFORE_RESULT,
      delegated: true,
      guidance: WAIT_INSTEAD_OF_REPLYING,
      session: "a delegated session, whose caller reads only the final reply",
    },
  ])(
    "tells the model how to wait on tasks in $session",
    async ({ absent, delegated, guidance }) => {
      setupMockAgent({
        finishReason: "stop",
        response: { messages: [{ content: "Done.", role: "assistant" }] },
        text: "Done.",
        toolCalls: [],
        toolResults: [],
      });
      const runStep = createToolLoopHarness(
        createTestConfig(undefined, { tools: createTaskToolMap() }),
      );
      const ctx = new ContextContainer();
      if (delegated) setDelegatedParent(ctx);

      await contextStorage.run(ctx, () =>
        runStep(createTestSession(), { message: "Research this." }),
      );

      const instructions = JSON.stringify(vi.mocked(ToolLoopAgent).mock.calls[0]?.[0].instructions);
      expect(instructions).toContain(guidance);
      expect(instructions).not.toContain(absent);
    },
  );

  it("emits the full terminal failure cascade on an explicit Gateway invalid-request error", async () => {
    const logs = captureLogRecords();
    setupMockAgentError(
      createGatewayModelCallError({
        gatewayName: "GatewayInvalidRequestError",
        gatewayType: "invalid_request_error",
        upstreamType: "invalid_request_error",
      }),
    );

    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(createTestConfig(emit));

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
    expect(logs.records).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: "AI Gateway rejected the model request before the agent produced a response.",
      }),
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
        const { onStepEnd, prepareStep } = settings;
        const isFirst = constructionIndex === 0;
        constructionIndex += 1;
        if (isFirst) {
          // The real AI SDK runs `prepareStep` before the model call
          // is dispatched, so `step.started` is emitted before the
          // upstream rejection arrives. Mirror that ordering in the
          // mock so the test can assert step.started is emitted
          // exactly once across the original + retry attempts.
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
            if (onStepEnd) {
              void Promise.resolve().then(() => onStepEnd(input.successResult));
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
        const reissueInstructions = reissueCall!.instructions as {
          role: string;
          content: string;
        };
        expect(reissueInstructions.role).toBe("system");
        expect(reissueInstructions.content).toContain("web_search");
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
      const logs = captureLogRecords();
      const resolveRuntimeContext = vi.fn((input: InstrumentationStepStartedEventInput) => ({
        "test.attempt": typeof input.modelInput.instructions === "string" ? "original" : "retry",
      }));
      declareTelemetry(
        {
          runtimeContext: resolveRuntimeContext,
        },
        undefined,
        "public",
      );
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
        instrumentation: declaredInstrumentation,
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
      const ctx = new ContextContainer();
      setConversationContext(ctx, "public", "channel:public");
      const result = await contextStorage.run(ctx, () => runStep(session, { message: "Hi" }));

      // The second agent was constructed for the retry.
      expect(constructedCalls.count()).toBe(2);
      expect(resolveRuntimeContext).toHaveBeenCalledTimes(2);
      expect(mockCreateAiSdkHookBridge.mock.calls.map(([attempt]) => attempt)).toEqual([
        expect.objectContaining({ attemptIndex: 0 }),
        expect.objectContaining({ attemptIndex: 1 }),
      ]);

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
      const retryInstructions = retryCall!.instructions as { role: string; content: string };
      expect(retryInstructions.role).toBe("system");
      expect(retryInstructions.content).toContain("web_search");
      expect(retryInstructions.content).toContain("not available");
      expect(resolveRuntimeContext.mock.calls[1]?.[0].modelInput.instructions).toEqual(
        retryInstructions,
      );
      expect(logs.records).toContainEqual(
        expect.objectContaining({
          level: "warn",
          message: "disabling unsupported provider tool(s); retrying step once",
        }),
      );
    });

    it("falls through to terminal cascade when recovery retry also fails", async () => {
      const logs = captureLogRecords();
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
      expect(logs.records).toContainEqual(
        expect.objectContaining({
          level: "warn",
          message: "disabling unsupported provider tool(s); retrying step once",
        }),
      );
      expect(logs.records).toContainEqual(
        expect.objectContaining({
          level: "error",
          message: "AI Gateway rejected the model request before the agent produced a response.",
        }),
      );
    });

    it("does not retry when the error is unrelated to unsupported provider tools", async () => {
      const logs = captureLogRecords();
      setupMockAgentError(new Error("Model blew up"));

      const { emit, events } = createEventCollector();
      const runStep = createToolLoopHarness(createTestConfig(emit));
      await runStep(createTestSession(), { message: "Hi" });

      // Exactly one agent construction — no recovery retry was attempted.
      expect(vi.mocked(ToolLoopAgent).mock.calls.length).toBe(1);

      const types = events.map((e) => e.type);
      // The unrelated error still flows through the recoverable cascade
      // (plain Error defaults to recoverable classification).
      expect(types).toContain("session.waiting");
      expect(logs.records).toContainEqual(
        expect.objectContaining({
          level: "error",
          message: "model call failed — parking session for retry by the user",
        }),
      );
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
      const runStep = createToolLoopHarness(createTestConfig(emit));

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
          kind: "execution.retry",
          role: "user",
        });
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

    it("permits fresh reads in the empty-response retry instruction", async () => {
      const staleReadCall = {
        input: { resource: "report" },
        toolCallId: "stale-read-1",
        toolName: "read_report",
        type: "tool-call" as const,
      };
      const staleReadResult = {
        ...staleReadCall,
        output: { type: "json" as const, value: { rows: 1 } },
        type: "tool-result" as const,
      };
      const tools = new Map([
        [
          "read_report",
          {
            description: "Read the report.",
            execute: vi.fn().mockResolvedValue({ rows: 2 }),
            inputSchema: jsonSchema({ type: "object" }),
            name: "read_report",
          },
        ],
        [
          "write_report",
          {
            description: "Write the report.",
            execute: vi.fn().mockResolvedValue({ saved: true }),
            inputSchema: jsonSchema({ type: "object" }),
            name: "write_report",
          },
        ],
      ]);
      const session = createTestSession({
        agent: {
          modelReference: { id: "test-model" },
          system: "You are a test assistant.",
          tools: [
            {
              description: "Read the report.",
              inputSchema: { type: "object" },
              name: "read_report",
            },
            {
              description: "Write the report.",
              inputSchema: { type: "object" },
              name: "write_report",
            },
          ],
        },
        history: [
          { content: "Read the report.", kind: "user", role: "user" },
          { content: [staleReadCall], role: "assistant" },
          { content: [staleReadResult], role: "tool" },
        ],
      });
      const refreshRequest = "Read the report again and tell me how many rows it has now.";

      setupFirstThenAgent(emptyResult, successResult);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { emit } = createEventCollector();
      const runStep = createToolLoopHarness(createTestConfig(emit, { tools }));

      try {
        await runStep(session, { message: refreshRequest });

        const retryCall = vi.mocked(ToolLoopAgent).mock.calls[1]?.[0];
        const retryAgent = vi.mocked(ToolLoopAgent).mock.results[1]?.value as {
          stream: ReturnType<typeof vi.fn>;
        };
        const retryMessages = retryAgent.stream.mock.calls[0]?.[0]?.messages as Array<{
          content: unknown;
          role: string;
        }>;

        expect(retryCall?.tools).toMatchObject({
          read_report: expect.anything(),
          write_report: expect.anything(),
        });
        expect(retryMessages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ content: refreshRequest, role: "user" }),
            expect.objectContaining({ content: [staleReadCall], role: "assistant" }),
            expect.objectContaining({ content: [staleReadResult], role: "tool" }),
          ]),
        );
        expect(retryMessages.at(-1)).toMatchObject({
          content: expect.stringContaining("use the appropriate read tools to get fresh results"),
          kind: "execution.retry",
          role: "user",
        });
        expect(retryMessages.at(-1)?.content).not.toMatch(/do not re-run tools/i);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("warns the model not to repeat a completed write", async () => {
      const writeCall = {
        input: { report: "updated" },
        toolCallId: "write-1",
        toolName: "write_report",
        type: "tool-call" as const,
      };
      const writeResult = {
        ...writeCall,
        output: { type: "json" as const, value: { saved: true } },
        type: "tool-result" as const,
      };
      const completedWrite = {
        finishReason: "tool-calls",
        response: {
          messages: [
            { content: [writeCall], role: "assistant" },
            { content: [writeResult], role: "tool" },
          ],
        },
        text: "",
        toolCalls: [writeCall],
        toolResults: [writeResult],
      };
      const tools = new Map([
        [
          "write_report",
          {
            description: "Write the report.",
            execute: vi.fn().mockResolvedValue({ saved: true }),
            inputSchema: jsonSchema({ type: "object" }),
            name: "write_report",
          },
        ],
      ]);

      setupMockAgentSequence([completedWrite, emptyResult, successResult]);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { emit } = createEventCollector();
      const runStep = createToolLoopHarness(createTestConfig(emit, { tools }));

      try {
        const first = await runStep(createTestSession(), { message: "Update the report." });
        expect(typeof first.next).toBe("function");
        if (typeof first.next !== "function") throw new Error("Expected a tool continuation.");

        await first.next(first.session);

        expect(vi.mocked(ToolLoopAgent)).toHaveBeenCalledTimes(3);
        const retryAgent = vi.mocked(ToolLoopAgent).mock.results[2]?.value as {
          stream: ReturnType<typeof vi.fn>;
        };
        const retryMessages = retryAgent.stream.mock.calls[0]?.[0]?.messages as Array<{
          content: unknown;
          role: string;
        }>;
        expect(retryMessages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ content: [writeCall], role: "assistant" }),
            expect.objectContaining({ content: [writeResult], role: "tool" }),
          ]),
        );
        expect(retryMessages.at(-1)).toMatchObject({
          content: expect.stringContaining(
            "Do not repeat writes or other side effects that already completed.",
          ),
          kind: "execution.retry",
          role: "user",
        });
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("reissues a blank 'stop' response instead of treating it as intentional silence", async () => {
      setupFirstThenAgent(emptyStopResult, successResult);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const runStep = createToolLoopHarness(createTestConfig());

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
      const runStep = createToolLoopHarness(createTestConfig(emit));

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
          kind: "execution.retry",
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
      const runStep = createToolLoopHarness(createTestConfig(emit));

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
      const runStep = createToolLoopHarness(createTestConfig(emit));

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
      model: agentCall?.model,
      context: undefined,
    });
    expect(stepResult.providerOptions).toEqual({
      gateway: { caching: "auto", sessionId: "test-session" },
    });
  });

  it("completes a connection's sign-in, then resumes the held turn's work", async () => {
    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "Signed in; continuing.", role: "assistant" }] },
      text: "Signed in; continuing.",
      toolCalls: [],
      toolResults: [],
    });
    const challenge = {
      attemptId: "attempt-statuspage",
      challenge: { url: "https://idp.example/authorize" },
      hookUrl: "https://app.example/eve/v1/connections/statuspage/callback",
      name: "statuspage",
    };
    // Alice's turn asked Bob's status page connection to sign in, and holds for it.
    const session = withPublished(createTestSession(), [
      { data: {}, type: "session.started" },
      { data: { sequence: 0, turnId: "turn_0" }, type: "turn.started" },
      createAuthorizationRequiredEvent({
        attemptId: challenge.attemptId,
        description: "Sign in to statuspage",
        name: challenge.name,
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_0",
        webhookUrl: challenge.hookUrl,
      }),
      { data: { on: "input", sequence: 0, turnId: "turn_0" }, type: "turn.waiting" },
    ] as UnstampedMessageStreamEvent[]);
    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(
      createTestConfig(emit, { signInCompletions: [challenge] as never }),
    );

    await runStep(session, undefined);

    expect(
      events.slice(0, 2).map((event) => [event.type, "turnId" in event.data! && event.data.turnId]),
    ).toEqual([
      ["authorization.completed", "turn_0"],
      ["step.started", "turn_0"],
    ]);
  });

  it("dispatches model selection with the active turn ID when a continuation has no turn input", async () => {
    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "Done", role: "assistant" }] },
      text: "Done",
      toolCalls: [],
      toolResults: [],
    });

    const resolveDynamicModel = vi.fn();
    const { emit } = createEventCollector();
    const harness = createToolLoopHarness(
      createTestConfig(emit, {
        participants: modelParticipants(resolveDynamicModel),
        tools: new Map(),
      }),
    );

    await contextStorage.run(new ContextContainer(), () => harness(createTestSession()));

    expect(resolveDynamicModel).toHaveBeenCalledWith(
      expect.objectContaining({ at: expect.objectContaining({ turnId: "turn_0" }) }),
    );
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
        { content: "Search release notes.", kind: "user" as const, role: "user" },
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
        { content: "Keep working while search resolves.", kind: "user" as const, role: "user" },
      ],
    });

    const harness = createToolLoopHarness(createTestConfig(emit, { tools: new Map() }));

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
    const harness = createToolLoopHarness(createTestConfig(emit, { tools: new Map() }));

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

    const harness = createToolLoopHarness(createTestConfig(undefined, { tools: new Map() }));
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

    const harness = createToolLoopHarness(createTestConfig(undefined, { tools: new Map() }));
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

    const harness = createToolLoopHarness(createTestConfig(undefined, { tools: new Map() }));
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
    const harness = createToolLoopHarness(createTestConfig(emit, { tools: new Map() }));

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

  // Alice's turn waits on two approvals and on Bob signing in to statuspage.
  async function parkedOnApprovalsAndSignIn(): Promise<HarnessSession> {
    const approval = (requestId: string, callId: string) => ({
      action: { callId, input: {}, kind: "tool-call" as const, toolName: "guarded_echo" },
      allowFreeform: false,
      display: "confirmation" as const,
      kind: "tool-approval" as const,
      options: [
        { id: "approve", label: "Approve" },
        { id: "cancel", label: "Cancel" },
      ],
      prompt: "Approve tool call: guarded_echo",
      requestId,
    });
    const parked = parkedOnApproval({
      requests: [approval("approval-1", "call-1"), approval("approval-2", "call-2")],
      responseMessages: [],
      session: createTestSession(),
    });
    const signIn = requireSignIn(sessionView(storedProjection(parked.state), parked.state), {
      challenges: [
        {
          attemptId: "attempt-statuspage",
          challenge: { url: "https://idp.example/authorize" },
          hookUrl: "https://app.example/eve/v1/connections/statuspage/callback",
          name: "statuspage",
        },
      ],
    });
    return withPublished(await applyTransition(parked, signIn, async () => {}), signIn.events);
  }

  it("answers a typed approval without withdrawing the turn's pending sign-ins", async () => {
    const session = await parkedOnApprovalsAndSignIn();
    const { emit, events } = createEventCollector();

    const result = await createToolLoopHarness(createTestConfig(emit))(session, {
      message: "approve",
    });

    expect(events.filter((event) => event.type === "authorization.completed")).toEqual([]);
    const view = sessionView(storedProjection(result.session.state), result.session.state);
    expect(view.signIns.map((challenge) => challenge.name)).toEqual(["statuspage"]);
    // The answer to the first approval waits for the second, as a press would.
    expect(view.turn.queued?.inputResponses).toEqual([
      { optionId: "approve", requestId: "approval-1" },
    ]);
  });

  it("withdraws the turn's pending sign-ins when a new message steers it", async () => {
    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "Sure.", role: "assistant" }] },
      text: "Sure.",
      toolCalls: [],
      toolResults: [],
    });
    const { emit, events } = createEventCollector();

    await createToolLoopHarness(createTestConfig(emit))(await parkedOnApprovalsAndSignIn(), {
      message: "Actually, can you check the weather first?",
    });

    expect(
      events
        .filter((event) => event.type === "authorization.completed")
        .map((event) => [event.data.name, event.data.outcome]),
    ).toEqual([["statuspage", "declined"]]);
  });

  it("emits compaction.requested and compaction.completed when compaction triggers", async () => {
    vi.mocked(shouldCompact).mockReturnValue(true);
    mockCompaction([
      createFrameworkUserMessage("context.compaction", "Summary of our conversation so far:"),
      { content: "summary", role: "assistant" },
      createUserMessage("user", "recent message"),
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
      createTestConfig(emit, {
        resolveModel: vi
          .fn()
          .mockResolvedValue({ modelId: "gpt-4", provider: "openai" } as LanguageModel),
      }),
    );
    const session = createTestSession({
      agent: {
        modelReference: {
          id: "openai/gpt-4",
          providerOptions: { openai: { store: false } },
        },
        system: "You are a test assistant.",
        tools: [{ description: "Adds numbers", name: "add", inputSchema: { type: "object" } }],
      },
      history: [
        { content: "old message", kind: "user" as const, role: "user" },
        { content: "old reply", role: "assistant" },
      ],
    });
    const auth = {
      attributes: {},
      authenticator: "oidc",
      principalId: "user_123",
      principalType: "user",
    };
    const ctx = new ContextContainer();
    ctx.set(AuthKey, auth);

    await contextStorage.run(ctx, () => runStep(session, { message: "Hi" }));

    expect(getCompatibilityEventTypes(events)).toEqual([
      "session.started",
      "turn.started",
      "message.received",
      "step.started",
      "compaction.requested",
      "compaction.completed",
      "message.completed",
      "step.completed",
      "turn.completed",
      "session.waiting",
    ]);

    expect(events.find((e) => e.type === "compaction.requested")?.data).toEqual({
      modelId: "openai/gpt-4",
      sequence: 0,
      sessionId: "test-session",
      stepIndex: 0,
      turnId: "turn_0",
      usageInputTokens: 5000,
    });

    expect(events.find((e) => e.type === "compaction.completed")?.data).toEqual({
      modelId: "openai/gpt-4",
      sequence: 0,
      sessionId: "test-session",
      stepIndex: 0,
      turnId: "turn_0",
    });
    expect(summaryCall()?.providerOptions).toEqual({
      openai: {
        safetyIdentifier: invocationOwnerKey(auth),
        store: false,
      },
    });
  });

  it("groups Gateway compaction under the forwarded trace conversation", async () => {
    vi.mocked(shouldCompact).mockReturnValue(true);
    mockCompaction([
      createFrameworkUserMessage("context.compaction", "Summary"),
      { content: "summary", role: "assistant" },
    ]);
    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "ok", role: "assistant" }] },
      text: "ok",
      toolCalls: [],
      toolResults: [],
    });
    const { emit } = createEventCollector();
    const config = createTestConfig(emit, {
      resolveModel: vi.fn().mockResolvedValue("anthropic/claude-sonnet-4-5"),
    });
    const session = createTestSession({ rootSessionId: "root-session" });
    const ctx = new ContextContainer();
    ctx.set(ConversationIdKey, "forwarded-conversation");

    await contextStorage.run(ctx, () => createToolLoopHarness(config)(session, { message: "Hi" }));

    expect(summaryCall()?.providerOptions).toEqual({
      gateway: { sessionId: "forwarded-conversation" },
    });
  });

  it("resolves model and step capabilities before compacting the final request", async () => {
    vi.mocked(shouldCompact).mockReturnValue(true);
    const compactedHistory: HarnessModelMessage[] = [
      { content: "Summary of our conversation so far:", kind: "context.compaction", role: "user" },
      { content: "summary", role: "assistant" },
      { content: "current", kind: "user" as const, role: "user" },
    ];
    vi.mocked(compactMessages).mockResolvedValue(compactedHistory);
    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "done", role: "assistant" }] },
      text: "done",
      toolCalls: [],
      toolResults: [],
    });

    const hidden = {
      content: "HIDE_FROM_COMPACTION",
      kind: "user" as const,
      role: "user" as const,
    };
    const preCompactionModelViews: Array<readonly ModelMessage[]> = [];
    const stepViews: Array<readonly ModelMessage[]> = [];
    const emit: HarnessEmitFn = async (event, messages) => {
      if (event.type === "step.started") stepViews.push(messages ?? []);
    };
    const runStep = createToolLoopHarness(
      createTestConfig(emit, {
        participants: modelParticipants(async ({ messages }) => {
          preCompactionModelViews.push(messages);
        }),
        historyProjector: ({ messages }) => messages.filter((message) => message !== hidden),
        resolveModel: vi
          .fn()
          .mockResolvedValue({ modelId: "gpt-4", provider: "openai" } as LanguageModel),
      }),
    );
    const session = createTestSession({
      history: [
        { content: "visible", kind: "user" as const, role: "user" },
        hidden,
        { content: "reply", role: "assistant" },
      ],
    });

    await contextStorage.run(new ContextContainer(), () =>
      runStep(session, { message: "current" }),
    );

    const preCompactionView = [
      { content: "visible", kind: "user" as const, role: "user" },
      { content: "reply", role: "assistant" },
      { content: "current", kind: "user" as const, role: "user" },
    ];
    expect(preCompactionModelViews).toEqual([preCompactionView]);
    expect(vi.mocked(compactMessages).mock.calls[0]?.[0]).toEqual(preCompactionView);
    expect(stepViews).toEqual([preCompactionView]);
  });

  it("clears static and dynamic user instructions without rerunning lifecycle events", async () => {
    const { emit, events } = createEventCollector();
    const resolveModel = vi.fn();
    const runStep = createToolLoopHarness(
      createTestConfig(emit, {
        clearOnly: true,
        resolveModel,
      }),
    );
    const state = { retained: "yes" };
    const limits = { maxInputTokensPerSession: 1_000 };
    const outputSchema = { type: "string" };
    const session = createTestSession({
      compaction: {
        lastKnownInputTokens: 9000,
        lastKnownPromptMessageCount: 2,
        recentWindowSize: 10,
        threshold: 100_000,
      },
      history: [
        { content: "Static user instructions.", kind: "user" as const, role: "user" },
        { content: "Dynamic user instructions.", kind: "user" as const, role: "user" },
        { content: "old reply", role: "assistant" },
      ],
      limits,
      outputSchema,
      state,
    });

    const result = await runStep(session);

    expect(result.next).toBeNull();
    expect(result.session).toMatchObject({
      agent: session.agent,
      compaction: { recentWindowSize: 10, threshold: 100_000 },
      continuationToken: session.continuationToken,
      history: [],
      limits,
      outputSchema,
      sessionId: session.sessionId,
      state,
    });
    expect(getCompatibilityEventTypes(events)).toEqual(["context.cleared", "session.waiting"]);
    expect(events.find((event) => event.type === "context.cleared")?.data).toEqual({
      sequence: 0,
      sessionId: "test-session",
      turnId: "turn_0",
    });
    expect(resolveModel).not.toHaveBeenCalled();
    expect(compactMessages).not.toHaveBeenCalled();
    expect(ToolLoopAgent).not.toHaveBeenCalled();
  });

  it("compacts user instructions as ordinary history without starting a model turn", async () => {
    const compactedHistory: HarnessModelMessage[] = [
      { content: "Summary of our conversation so far:", kind: "context.compaction", role: "user" },
      { content: "summary", role: "assistant" },
    ];
    vi.mocked(compactMessages).mockResolvedValue(compactedHistory);

    const { emit, events } = createEventCollector();
    const hidden = {
      content: "Hidden internal context.",
      kind: "user" as const,
      role: "user" as const,
    };
    const runStep = createToolLoopHarness(
      createTestConfig(emit, {
        compactOnly: true,
        historyProjector: ({ messages }) => messages.filter((message) => message !== hidden),
        resolveModel: vi
          .fn()
          .mockResolvedValue({ modelId: "gpt-4", provider: "openai" } as LanguageModel),
      }),
    );
    const session = createTestSession({
      compaction: {
        lastKnownInputTokens: 9000,
        lastKnownPromptMessageCount: 2,
        recentWindowSize: 10,
        threshold: 100_000,
      },
      history: [
        { content: "Static user instructions.", kind: "user" as const, role: "user" },
        hidden,
        { content: "Dynamic user instructions.", kind: "user" as const, role: "user" },
        { content: "old reply", role: "assistant" },
      ],
    });

    const result = await runStep(session);

    expect(result.next).toBeNull();
    expect(result.session.history).toEqual(compactedHistory);
    expect(result.session.compaction).toEqual({ recentWindowSize: 10, threshold: 100_000 });
    expect(shouldCompact).not.toHaveBeenCalled();
    expect(compactMessages).toHaveBeenCalledOnce();
    expect(vi.mocked(compactMessages).mock.calls[0]?.[0]).toEqual([
      { content: "Static user instructions.", kind: "user" as const, role: "user" },
      { content: "Dynamic user instructions.", kind: "user" as const, role: "user" },
      { content: "old reply", role: "assistant" },
    ]);
    expect(ToolLoopAgent).not.toHaveBeenCalled();
    expect(getCompatibilityEventTypes(events)).toEqual([
      "compaction.requested",
      "compaction.completed",
      "session.waiting",
    ]);
  });

  it("resolves a step-scoped dynamic model before manual compaction", async () => {
    const compactedHistory: HarnessModelMessage[] = [
      createFrameworkUserMessage("context.compaction", "Summary of our conversation so far:"),
      { content: "summary", role: "assistant" },
    ];
    vi.mocked(compactMessages).mockResolvedValue(compactedHistory);

    const selectedModel = new MockLanguageModelV3({
      modelId: "gpt-5",
      provider: "openai.chat",
    });
    const resolveDynamicModel: StepParticipants["selectModel"] = vi.fn(async () => {
      contextStorage.getStore()!.setVirtualContext(LiveStepDynamicModelSelectionKey, {
        model: selectedModel,
        reference: {
          contextWindowTokens: 200_000,
          id: "openai/gpt-5",
        },
      });
    });
    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(
      createTestConfig(emit, {
        compactOnly: true,
        participants: modelParticipants(resolveDynamicModel),
      }),
    );
    const session = createTestSession({
      agent: {
        dynamicModel: true,
        system: "You are a test assistant.",
        tools: [{ description: "Adds numbers", name: "add", inputSchema: { type: "object" } }],
      },
      history: [
        { content: "old message", kind: "user" as const, role: "user" },
        { content: "old reply", role: "assistant" },
      ],
    });
    const ctx = new ContextContainer();

    const result = await contextStorage.run(ctx, () => runStep(session));

    expect(result.next).toBeNull();
    expect(result.session.history).toEqual(compactedHistory);
    expect(resolveDynamicModel).toHaveBeenCalledOnce();
    expect(getCompatibilityEventTypes(events)).toEqual([
      "compaction.requested",
      "compaction.completed",
      "session.waiting",
    ]);
  });

  it("returns an empty session to its waiting boundary after manual compaction", async () => {
    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(
      createTestConfig(emit, {
        compactOnly: true,
      }),
    );
    const session = createTestSession({ history: [] });

    const result = await runStep(session);

    expect(result.next).toBeNull();
    // Only the lifecycle the step published joins the session.
    expect({ ...result.session, state: session.state }).toEqual(session);
    expect(getCompatibilityEventTypes(events)).toEqual(["session.waiting"]);
    expect(ToolLoopAgent).not.toHaveBeenCalled();
    expect(compactMessages).not.toHaveBeenCalled();
  });

  it("returns a failed manual compaction to its waiting boundary", async () => {
    const logs = captureLogRecords();
    vi.mocked(compactMessages).mockRejectedValueOnce(new Error("summary failed"));

    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(
      createTestConfig(emit, {
        compactOnly: true,
        resolveModel: vi
          .fn()
          .mockResolvedValue({ modelId: "gpt-4", provider: "openai" } as LanguageModel),
      }),
    );
    const session = createTestSession({
      history: [{ content: "old message", kind: "user" as const, role: "user" }],
    });
    const ctx = new ContextContainer();
    ctx.set(HistoryStateKey, { announcements: { skills: "old message" } });
    const result = await contextStorage.run(ctx, () => runStep(session));

    expect(result.next).toBeNull();
    // Only the lifecycle the step published joins the session.
    expect({ ...result.session, state: session.state }).toEqual(session);
    expect(ctx.get(HistoryStateKey)).toEqual({ announcements: { skills: "old message" } });
    expect(getCompatibilityEventTypes(events)).toEqual(["compaction.requested", "session.waiting"]);
    expect(ToolLoopAgent).not.toHaveBeenCalled();
    expect(logs.records).toContainEqual(
      expect.objectContaining({ level: "error", message: "manual session compaction failed" }),
    );
  });

  it("returns a failed manual model resolution to its waiting boundary", async () => {
    const logs = captureLogRecords();
    const { emit, events } = createEventCollector();
    const runStep = createToolLoopHarness(
      createTestConfig(emit, {
        compactOnly: true,
        resolveModel: vi.fn().mockRejectedValueOnce(new Error("model unavailable")),
      }),
    );
    const session = createTestSession({
      history: [{ content: "old message", kind: "user" as const, role: "user" }],
    });

    const result = await runStep(session);

    expect(result.next).toBeNull();
    // Only the lifecycle the step published joins the session.
    expect({ ...result.session, state: session.state }).toEqual(session);
    expect(getCompatibilityEventTypes(events)).toEqual(["session.waiting"]);
    expect(compactMessages).not.toHaveBeenCalled();
    expect(ToolLoopAgent).not.toHaveBeenCalled();
    expect(logs.records).toContainEqual(
      expect.objectContaining({ level: "error", message: "manual session compaction failed" }),
    );
  });

  it("uses the authored compaction model when one is configured", async () => {
    vi.mocked(shouldCompact).mockReturnValue(true);
    mockCompaction([
      createFrameworkUserMessage("context.compaction", "Summary of our conversation so far:"),
      { content: "summary", role: "assistant" },
      createUserMessage("user", "recent message"),
    ]);

    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "Got it.", role: "assistant" }] },
      text: "Got it.",
      toolCalls: [],
      toolResults: [],
    });

    const config: ToolLoopHarnessConfig = {
      ...createTestConfig(),
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
        { content: "old message", kind: "user" as const, role: "user" },
        { content: "old reply", role: "assistant" },
      ],
    });

    await runStep(session, { message: "Hi" });

    const call = vi.mocked(compactMessages).mock.calls[0];
    expect(call?.[0]).toEqual([
      { content: "old message", kind: "user" as const, role: "user" },
      { content: "old reply", role: "assistant" },
      { content: "Hi", kind: "user" as const, role: "user" },
    ]);
    expect(summaryCall()?.model).toMatchObject({
      modelId: "summary-model",
      provider: "openai",
    });
    expect(call?.[1]).toEqual(
      expect.objectContaining({
        recentWindowSize: 10,
        threshold: expect.any(Number),
      }),
    );
    expect(call?.[1].threshold).toBeLessThan(100_000);
    expect(call?.[1].threshold).toBeGreaterThan(99_000);
    expect(summaryCall()?.providerOptions).toBeUndefined();
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
    const runStep = createToolLoopHarness(createTestConfig(emit));

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
    const runStep = createToolLoopHarness(createTestConfig(emit));

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
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_0",
      },
      {
        messageDelta: " there.",
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

    const config = createTestConfig();
    const runStep = createToolLoopHarness(config);

    const result = await runStep(createTestSession(), { message: "Hi" });

    expect(result.session.compaction).toMatchObject({
      lastKnownInputTokens: 321,
      lastKnownPromptMessageCount: 1,
    });
  });

  it("compaction appends a framework continuation when recent window trails with assistant", async () => {
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

    const step1Harness = createToolLoopHarness(createTestConfig());
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

    const step2Harness = createToolLoopHarness(createTestConfig());
    const result2 = await step2Harness(result1.session);
    expect(result2.next).toBeNull();
    expect(result2.session.history.at(-1)).toMatchObject({
      content: "The answer is 42.",
      role: "assistant",
    });

    // Step 3: new turn with compaction. The mock simulates the
    // guarded output from the real compactMessages: trailing
    // assistant gets a framework continuation appended.
    vi.mocked(shouldCompact).mockReturnValue(true);
    vi.mocked(compactMessages).mockResolvedValue([
      createFrameworkUserMessage("context.compaction", "Summary of our conversation so far:"),
      { content: "summary", role: "assistant" },
      { content: "The answer is 42.", role: "assistant" },
      createFrameworkUserMessage("execution.continuation", "Continue."),
    ]);

    setupMockAgent({
      finishReason: "stop",
      response: { messages: [{ content: "Sure.", role: "assistant" }] },
      text: "Sure.",
      toolCalls: [],
      toolResults: [],
    });

    const step3Harness = createToolLoopHarness(createTestConfig());
    await step3Harness(result2.session, {});

    // Verify the model received the continuation user message, not the
    // trailing assistant.
    const instance = vi.mocked(ToolLoopAgent).mock.results.at(-1)?.value as {
      stream: ReturnType<typeof vi.fn>;
    };
    const modelMessages = instance.stream.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(modelMessages.messages.at(-1)).toEqual({
      content: "Continue.",
      kind: "execution.continuation",
      role: "user",
    });
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
        model: LanguageModel;
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
          | { stream: ReturnType<typeof vi.fn> }
          | undefined;
        const call = instance?.stream.mock.calls[0]?.[0] as
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
          model: settings.model,
          stepNumber: 0,
          steps: [],
        });

        return {
          instructions: structuredClone(settings.instructions),
          messages: structuredClone(prepared.messages ?? call.messages),
          providerOptions: structuredClone(prepared.providerOptions),
          tools: Object.entries(settings.tools ?? {}).map(([name, tool]) => ({
            description: structuredClone(tool.description),
            inputSchema: structuredClone((tool.inputSchema as { jsonSchema: unknown }).jsonSchema),
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
      const config = createTestConfig(undefined, {
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
        { gateway: { caching: "auto", sessionId: "test-session" } },
        { gateway: { caching: "auto", sessionId: "test-session" } },
        { gateway: { caching: "auto", sessionId: "test-session" } },
      ]);
      expect(modelCalls.map((call) => call.messages)).toEqual([
        [{ content: "Add 1 and 2.", kind: "user" as const, role: "user" }],
        [
          { content: "Add 1 and 2.", kind: "user" as const, role: "user" },
          toolCallMessage,
          toolResultMessage,
        ],
        [
          { content: "Add 1 and 2.", kind: "user" as const, role: "user" },
          toolCallMessage,
          toolResultMessage,
          firstAnswerMessage,
          { content: "Can you confirm?", kind: "user" as const, role: "user" },
        ],
      ]);
    });

    it("threads the active caller into OpenAI provider options across turns", async () => {
      setupStopResult();
      const auth = {
        attributes: {},
        authenticator: "oidc",
        principalId: "user_123",
        principalType: "user",
      };
      const session = createTestSession({
        agent: {
          modelReference: {
            id: "openai/gpt-5.6-sol",
            providerOptions: {
              openai: { store: false },
            },
          },
          system: "",
          tools: [{ description: "Adds numbers", name: "add", inputSchema: { type: "object" } }],
        },
      });
      const runStep = createToolLoopHarness(
        createTestConfig(undefined, {
          resolveModel: vi.fn().mockResolvedValue("openai/gpt-5.6-sol"),
        }),
      );
      const ctx = new ContextContainer();
      ctx.set(AuthKey, auth);

      const first = await contextStorage.run(ctx, () => runStep(session, { message: "hi" }));
      const nextAuth = { ...auth, principalId: "user_456" };
      ctx.set(AuthKey, nextAuth);
      await contextStorage.run(ctx, () => runStep(first.session, { message: "again" }));

      const readProviderOptions = async (index: number) => {
        const agentCall = vi.mocked(ToolLoopAgent).mock.calls[index]?.[0];
        const prepareStep = getPrepareStep<unknown[], { providerOptions?: unknown }>(
          agentCall?.prepareStep,
        );
        return (
          await prepareStep({
            context: undefined,
            messages: [],
            model: agentCall?.model,
            stepNumber: 0,
            steps: [],
          })
        ).providerOptions;
      };

      await expect(readProviderOptions(0)).resolves.toEqual({
        gateway: { caching: "auto", sessionId: "test-session" },
        openai: { safetyIdentifier: invocationOwnerKey(auth), store: false },
      });
      await expect(readProviderOptions(1)).resolves.toEqual({
        gateway: { caching: "auto", sessionId: "test-session" },
        openai: { safetyIdentifier: invocationOwnerKey(nextAuth), store: false },
      });
    });

    it("gateway-auto path: merges gateway.caching='auto' into providerOptions for string model ids", async () => {
      setupStopResult();
      const config: ToolLoopHarnessConfig = {
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
        model: agentCall?.model,
        context: undefined,
      });
      expect(stepResult.providerOptions).toEqual({
        gateway: { caching: "auto", sessionId: "test-session" },
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
        model: agentCall?.model,
        context: undefined,
      });
      expect(stepResult.providerOptions).toEqual({
        gateway: { order: ["anthropic", "bedrock"], caching: "auto", sessionId: "test-session" },
      });
    });

    it("anthropic-direct path: prepareStep marks last user and last assistant messages", async () => {
      setupStopResult();
      const config: ToolLoopHarnessConfig = {
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
          { content: "a", kind: "user" as const, role: "user" },
          { content: "b", role: "assistant" },
        ],
      });
      await runStep(session, { message: "c" });

      const agentCall = vi.mocked(ToolLoopAgent).mock.calls[0]?.[0];
      const prepareStep = getPrepareStep<
        Array<{ role: string; content: string; kind?: string; providerOptions?: unknown }>,
        { messages?: Array<{ providerOptions?: unknown }> }
      >(agentCall?.prepareStep);

      const result = await prepareStep({
        messages: [
          { kind: "user" as const, role: "user", content: "a" },
          { role: "assistant", content: "b" },
          { kind: "user" as const, role: "user", content: "c" },
        ],
        stepNumber: 0,
        steps: [],
        model: agentCall?.model,
        context: undefined,
      });

      expect(result.messages?.[0]?.providerOptions).toBeUndefined();
      expect(result.messages?.[1]?.providerOptions).toEqual({
        anthropic: { cacheControl: { type: "ephemeral" } },
        bedrock: { cachePoint: { type: "default" } },
      });
      expect(result.messages?.[2]?.providerOptions).toEqual({
        anthropic: { cacheControl: { type: "ephemeral" } },
        bedrock: { cachePoint: { type: "default" } },
      });
    });

    it("none path: direct OpenAI instance gets no caching changes", async () => {
      setupStopResult();
      const config: ToolLoopHarnessConfig = {
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
        model: agentCall?.model,
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
      const runStep = createToolLoopHarness(createTestConfig(emit));
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
      const runStep = createToolLoopHarness(createTestConfig(emit));
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
      const runStep = createToolLoopHarness(createTestConfig(emit));
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
          resolveModel: vi.fn().mockResolvedValue("anthropic/claude-sonnet-4-5"),
          runtimeIdentity: {
            agentId: "weather-agent",
            agentName: "Weather Agent",
            eveVersion: "0.0.0",
          },
          tools: new Map(),
        };
        const runStep = createToolLoopHarness(config);
        await runStep(createTestSession(), { message: "hi" });

        const agentCall = vi.mocked(ToolLoopAgent).mock.calls[0]?.[0];
        expect(agentCall?.headers).toEqual({
          "x-title": "Weather Agent",
          "http-referer": "https://my-agent.vercel.app",
          "user-agent": expect.stringMatching(/^eve\/.+/),
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
          resolveModel: vi.fn().mockResolvedValue("anthropic/claude-sonnet-4-5"),
          runtimeIdentity: {
            agentId: "weather-agent",
            eveVersion: "0.0.0",
          },
          tools: new Map(),
        };
        const runStep = createToolLoopHarness(config);
        await runStep(createTestSession(), { message: "hi" });

        const agentCall = vi.mocked(ToolLoopAgent).mock.calls[0]?.[0];
        expect(agentCall?.headers).toEqual({
          "x-title": "weather-agent",
          "user-agent": expect.stringMatching(/^eve\/.+/),
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
          resolveModel: vi.fn().mockResolvedValue("anthropic/claude-sonnet-4-5"),
          runtimeIdentity: {
            agentId: "my-agent",
            agentName: "My Agent",
            eveVersion: "0.0.0",
          },
          tools: new Map(),
        };
        const runStep = createToolLoopHarness(config);
        await runStep(createTestSession(), { message: "hi" });

        const agentCall = vi.mocked(ToolLoopAgent).mock.calls[0]?.[0];
        expect(agentCall?.headers).toEqual({
          "x-title": "My Agent",
          "http-referer": "https://preview-123.vercel.app",
          "user-agent": expect.stringMatching(/^eve\/.+/),
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
        resolveModel: vi.fn().mockResolvedValue({
          provider: "anthropic.messages",
          modelId: "claude-sonnet-4-5-20250514",
          specificationVersion: "v3",
        } as unknown as LanguageModel),
        runtimeIdentity: {
          agentId: "my-agent",
          agentName: "My Agent",
          eveVersion: "0.0.0",
        },
        tools: new Map(),
      };
      const runStep = createToolLoopHarness(config);
      await runStep(createTestSession(), { message: "hi" });

      const agentCall = vi.mocked(ToolLoopAgent).mock.calls[0]?.[0];
      expect(agentCall?.headers).toBeUndefined();
    });

    it("sets the eve user-agent for explicit Gateway model objects", async () => {
      setupStopResultForAttribution();
      const config: ToolLoopHarnessConfig = {
        resolveModel: vi.fn().mockResolvedValue(
          new MockLanguageModelV3({
            provider: "gateway.language-model",
            modelId: "anthropic/claude-sonnet-4-5",
          }),
        ),
        tools: new Map(),
      };
      const runStep = createToolLoopHarness(config);
      await runStep(createTestSession(), { message: "hi" });

      const agentCall = vi.mocked(ToolLoopAgent).mock.calls[0]?.[0];
      expect(agentCall?.headers).toEqual({
        "user-agent": expect.stringMatching(/^eve\/.+/),
      });
    });

    it("sets the eve user-agent when no app attribution is available", async () => {
      setupStopResultForAttribution();
      const originalProductionUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;
      const originalUrl = process.env.VERCEL_URL;
      delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
      delete process.env.VERCEL_URL;
      try {
        const config: ToolLoopHarnessConfig = {
          resolveModel: vi.fn().mockResolvedValue("anthropic/claude-sonnet-4-5"),
          tools: new Map(),
        };
        const runStep = createToolLoopHarness(config);
        await runStep(createTestSession(), { message: "hi" });

        const agentCall = vi.mocked(ToolLoopAgent).mock.calls[0]?.[0];
        expect(agentCall?.headers).toEqual({
          "user-agent": expect.stringMatching(/^eve\/.+/),
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

    it("derives compaction attribution from the compaction model", async () => {
      vi.mocked(shouldCompact).mockReturnValueOnce(true);
      mockCompaction([
        createFrameworkUserMessage("context.compaction", "Summary of our conversation so far:"),
        { content: "summary", role: "assistant" },
      ]);
      setupStopResultForAttribution();

      const originalProductionUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;
      process.env.VERCEL_PROJECT_PRODUCTION_URL = "my-agent.vercel.app";
      try {
        const { emit } = createEventCollector();
        const config: ToolLoopHarnessConfig = {
          handleEvent: emit,
          resolveModel: vi.fn().mockImplementation(async (reference) =>
            reference.id === "compaction-model"
              ? "anthropic/claude-sonnet-4-5"
              : new MockLanguageModelV3({
                  provider: "anthropic.messages",
                  modelId: "claude-sonnet-4-5-20250514",
                }),
          ),
          runtimeIdentity: {
            agentId: "weather-agent",
            agentName: "Weather Agent",
            eveVersion: "0.0.0",
          },
          tools: new Map(),
        };
        const runStep = createToolLoopHarness(config);
        await runStep(
          createTestSession({
            agent: {
              compactionModelReference: { id: "compaction-model" },
              modelReference: { id: "main-model" },
              system: "You are a test assistant.",
              tools: [],
            },
          }),
          { message: "hi" },
        );

        const agentCall = vi.mocked(ToolLoopAgent).mock.calls[0]?.[0];
        expect(agentCall?.headers).toBeUndefined();
        expect(summaryCall()?.headers).toEqual({
          "x-title": "Weather Agent",
          "http-referer": "https://my-agent.vercel.app",
          "user-agent": expect.stringMatching(/^eve\/.+/),
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

      declareTelemetry({ tracePolicy: () => true });
      const config = createTestConfig();
      const runStep = createToolLoopHarness(config);
      const result = await runStep(createTestSession(), { message: "add stuff" });
      declareTelemetry(undefined);

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

      const config = createTestConfig();
      const runStep = createToolLoopHarness(config);
      const result = await runStep(createTestSession(), { message: "add stuff" });

      expect(result.next).toBe(runStep);
      expect(result.session.state?.["eve.harness.turnTrace"]).toBeUndefined();
    });

    it("continuation step restores the persisted parent as a remote trace context", async () => {
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

      declareTelemetry({ tracePolicy: () => true });
      const step1Config = createTestConfig();
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

      const step2Config = createTestConfig();
      const step2 = createToolLoopHarness(step2Config);
      // No input — continuation step
      const result2 = await step2(result1.session);
      declareTelemetry(undefined);

      expect(result2.next).toBeNull();

      // Verify the stored span context was restored
      expect(wrapSpy).toHaveBeenCalledWith({
        isRemote: true,
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
    it("keeps integrations metadata-only on a rejected trace", async () => {
      setupMockAgent({
        finishReason: "stop",
        response: { messages: [{ content: "Hello!", role: "assistant" }] },
        text: "Hello!",
        toolCalls: [],
        toolResults: [],
      });
      declareTelemetry({
        recordInputs: true,
        recordOutputs: true,
        tracePolicy: () => false,
      });
      mockGetRegisteredTelemetryIntegrations.mockReturnValue([
        registeredOtelIntegration,
        registeredAuthorIntegration,
      ]);
      const runStep = createToolLoopHarness(
        createTestConfig(undefined, {
          instrumentation: declaredInstrumentation,
        }),
      );

      await runStep(createTestSession(), { message: "private" });

      const agentCall = vi.mocked(ToolLoopAgent).mock.calls[0]?.[0] as {
        telemetry?: {
          integrations?: unknown[];
          recordInputs?: boolean;
          recordOutputs?: boolean;
        };
      };
      expect(agentCall.telemetry).toMatchObject({
        integrations: [
          mockCreateAiSdkHookBridge.mock.results[0]!.value,
          registeredOtelIntegration,
          registeredAuthorIntegration,
        ],
        recordInputs: false,
        recordOutputs: false,
      });
      expect(mockGetRegisteredTelemetryIntegrations).toHaveBeenCalledWith({
        sanitizeEveOtelErrors: true,
      });
    });

    it("keeps compaction telemetry metadata-only on a rejected trace", async () => {
      vi.mocked(shouldCompact).mockReturnValueOnce(true);
      mockCompaction([
        createFrameworkUserMessage("context.compaction", "Summary of our conversation so far:"),
        { content: "summary", role: "assistant" },
      ]);
      setupMockAgent({
        finishReason: "stop",
        response: { messages: [{ content: "Hello!", role: "assistant" }] },
        text: "Hello!",
        toolCalls: [],
        toolResults: [],
      });
      declareTelemetry(
        {
          recordInputs: true,
          recordOutputs: true,
          tracePolicy: () => false,
        },
        { action: "drop" },
      );
      const runStep = createToolLoopHarness(createTestConfig());

      await runStep(createTestSession(), { message: "private" });

      expect(summaryCall()?.telemetry).toMatchObject({
        functionId: "eve.compaction",
        isEnabled: true,
        recordInputs: false,
        recordOutputs: false,
      });
    });

    it("keeps the content-capable lifecycle bridge active on a rejected trace", async () => {
      setupMockAgent({
        finishReason: "stop",
        response: { messages: [{ content: "Hello!", role: "assistant" }] },
        text: "Hello!",
        toolCalls: [],
        toolResults: [],
      });
      declareTelemetry({ tracePolicy: () => false }, { action: "drop" });
      const attemptCompleted = vi.fn();
      const hooks = createInstrumentationHooks([
        {
          events: { "step.attempt.completed": attemptCompleted },
          name: "analytics",
          tracePolicy: () => ({ emit: true, recordInputs: true, recordOutputs: true }),
        },
      ]);
      const runStep = createToolLoopHarness(
        createTestConfig(undefined, {
          instrumentation: bindHookInstrumentation(hooks, undefined, true),
        }),
      );
      const ctx = new ContextContainer();
      setConversationContext(ctx, "private", "channel:private");

      await contextStorage.run(ctx, () => runStep(createTestSession(), { message: "private" }));

      expect(attemptCompleted).toHaveBeenCalledOnce();
      expect(mockCreateAiSdkHookBridge.mock.calls[0]?.[1]).toMatchObject({
        capturesContent: true,
        capturesInputs: true,
        capturesOutputs: true,
      });
      const agentCall = vi.mocked(ToolLoopAgent).mock.calls[0]?.[0] as {
        telemetry?: { integrations?: unknown[] };
      };
      expect(agentCall.telemetry?.integrations).toEqual([
        mockCreateAiSdkHookBridge.mock.results[0]!.value,
      ]);
    });

    it("keeps provider content independent from emitted OTel content policy", async () => {
      setupMockAgent({
        finishReason: "stop",
        response: { messages: [{ content: "Hello!", role: "assistant" }] },
        text: "Hello!",
        toolCalls: [],
        toolResults: [],
      });
      declareTelemetry({
        recordInputs: true,
        recordOutputs: true,
        tracePolicy: () => ({ emit: true, recordInputs: false, recordOutputs: false }),
      });
      const hooks = createInstrumentationHooks([
        {
          name: "analytics",
          tracePolicy: () => ({ emit: true, recordInputs: true, recordOutputs: true }),
        },
      ]);
      const runStep = createToolLoopHarness(
        createTestConfig(undefined, {
          instrumentation: bindHookInstrumentation(hooks, undefined, true),
        }),
      );

      await runStep(createTestSession(), { message: "private" });

      expect(mockCreateAiSdkHookBridge.mock.calls[0]?.[1]).toMatchObject({
        capturesContent: true,
        capturesInputs: true,
        capturesOutputs: true,
      });
      const agentCall = vi.mocked(ToolLoopAgent).mock.calls[0]?.[0] as {
        telemetry?: { recordInputs?: boolean; recordOutputs?: boolean };
      };
      expect(agentCall.telemetry).toMatchObject({
        recordInputs: false,
        recordOutputs: false,
      });
    });

    it.each([
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ] as const)("applies the explicit %s/%s capture decision", async (inputs, outputs) => {
      setupMockAgent({
        finishReason: "stop",
        response: { messages: [{ content: "Hello!", role: "assistant" }] },
        text: "Hello!",
        toolCalls: [],
        toolResults: [],
      });
      declareTelemetry(
        {
          recordInputs: true,
          recordOutputs: true,
          tracePolicy: () => ({
            emit: true,
            recordInputs: inputs,
            recordOutputs: outputs,
          }),
        },
        { action: "record", recordInputs: inputs, recordOutputs: outputs },
        "public",
      );
      const runStep = createToolLoopHarness(createTestConfig());
      const ctx = new ContextContainer();
      setConversationContext(ctx, "public", "channel:public");

      await contextStorage.run(ctx, () => runStep(createTestSession(), { message: "hello" }));

      const agentCall = vi.mocked(ToolLoopAgent).mock.calls[0]?.[0] as {
        telemetry?: { recordInputs?: boolean; recordOutputs?: boolean };
      };
      expect(agentCall.telemetry).toMatchObject({
        recordInputs: inputs,
        recordOutputs: outputs,
      });
      expect(mockGetRegisteredTelemetryIntegrations).toHaveBeenCalledWith({
        sanitizeEveOtelErrors: !(inputs && outputs),
      });
    });

    it("lets destination capture settings narrow an explicit content decision", async () => {
      setupMockAgent({
        finishReason: "stop",
        response: { messages: [{ content: "Hello!", role: "assistant" }] },
        text: "Hello!",
        toolCalls: [],
        toolResults: [],
      });
      declareTelemetry(
        {
          recordInputs: false,
          recordOutputs: true,
          tracePolicy: () => ({
            emit: true,
            recordInputs: true,
            recordOutputs: true,
          }),
        },
        { action: "record", recordInputs: true, recordOutputs: true },
        "public",
      );
      const runStep = createToolLoopHarness(createTestConfig());
      const ctx = new ContextContainer();
      setConversationContext(ctx, "public", "channel:public");

      await contextStorage.run(ctx, () => runStep(createTestSession(), { message: "hello" }));

      const agentCall = vi.mocked(ToolLoopAgent).mock.calls[0]?.[0] as {
        telemetry?: { recordInputs?: boolean; recordOutputs?: boolean };
      };
      expect(agentCall.telemetry).toMatchObject({
        recordInputs: false,
        recordOutputs: true,
      });
      expect(mockGetRegisteredTelemetryIntegrations).toHaveBeenCalledWith({
        sanitizeEveOtelErrors: true,
      });
    });

    it("uses the injected decision instead of reinterpreting the trace seed", async () => {
      setupMockAgent({
        finishReason: "stop",
        response: { messages: [{ content: "Hello!", role: "assistant" }] },
        text: "Hello!",
        toolCalls: [],
        toolResults: [],
      });
      const tracePolicy = vi.fn(() => true);
      declareTelemetry(
        { recordInputs: true, recordOutputs: true, tracePolicy },
        { action: "drop" },
      );
      const runStep = createToolLoopHarness(createTestConfig());
      const ctx = new ContextContainer();
      ctx.set(SessionTraceSeedKey, {
        decision: { action: "drop" },
        spanId: "1".repeat(16),
        traceFlags: 0,
        traceId: "2".repeat(32),
      });

      await contextStorage.run(ctx, () => runStep(createTestSession(), { message: "private" }));

      const agentCall = vi.mocked(ToolLoopAgent).mock.calls[0]?.[0] as {
        telemetry?: { integrations?: unknown[] };
      };
      expect(agentCall.telemetry?.integrations).toEqual([
        mockCreateAiSdkHookBridge.mock.results[0]!.value,
      ]);
      expect(tracePolicy).not.toHaveBeenCalled();
    });

    it("emits the authored turn trace with the session and turn preamble", async () => {
      const authoredTrace = {
        spanId: "0123456789abcdef",
        traceFlags: 1,
        traceId: "0123456789abcdef0123456789abcdef",
      };
      const authoredSpan = trace.wrapSpanContext(authoredTrace);
      const getTracerSpy = vi.spyOn(trace, "getTracer").mockReturnValue({
        startSpan: vi.fn(() => authoredSpan),
      } as ReturnType<typeof trace.getTracer>);
      setupMockAgent({
        finishReason: "stop",
        response: { messages: [{ content: "Hello!", role: "assistant" }] },
        text: "Hello!",
        toolCalls: [],
        toolResults: [],
      });
      const events: UnstampedMessageStreamEvent[] = [];
      declareTelemetry({ tracePolicy: () => true });
      const runStep = createToolLoopHarness(
        createTestConfig(async (event) => {
          events.push(event);
        }),
      );

      try {
        const result = await runStep(createTestSession(), { message: "hi" });
        const storedTrace = result.session.state?.["eve.harness.turnTrace"];
        const sessionStarted = events.find((event) => event.type === "session.started");
        const turnStarted = events.find((event) => event.type === "turn.started");
        expect(storedTrace).toEqual(authoredTrace);
        expect(sessionStarted?.data.trace).toEqual(authoredTrace);
        expect(turnStarted?.data.trace).toEqual(authoredTrace);
      } finally {
        getTracerSpy.mockRestore();
        declareTelemetry(undefined);
      }
    });

    it("retains environment context when runtimeContext returns no values", async () => {
      setupMockAgent({
        finishReason: "stop",
        response: { messages: [{ content: "Hello!", role: "assistant" }] },
        text: "Hello!",
        toolCalls: [],
        toolResults: [],
      });

      declareTelemetry({ runtimeContext: () => undefined, tracePolicy: () => true });
      const config = createTestConfig();
      const runStep = createToolLoopHarness(config);
      await runStep(createTestSession(), { message: "hi" });
      declareTelemetry(undefined);

      const agentCall = vi.mocked(ToolLoopAgent).mock.calls[0]?.[0] as {
        runtimeContext?: Record<string, unknown>;
        telemetry?: { integrations?: unknown; isEnabled?: boolean };
      };
      const runtimeContext = agentCall?.runtimeContext;
      expect(runtimeContext).toEqual({ "eve.environment": "test" });
      expect(agentCall?.telemetry?.isEnabled).toBe(true);
      expect(agentCall?.telemetry?.integrations).toEqual([
        mockCreateAiSdkHookBridge.mock.results[0]!.value,
      ]);
      expect(mockGetRegisteredTelemetryIntegrations).toHaveBeenCalledWith({
        sanitizeEveOtelErrors: true,
      });
    });

    it("injects one provider-neutral bridge when lifecycle hooks opt in", async () => {
      setupMockAgent({
        finishReason: "stop",
        response: { messages: [{ content: "Hello!", role: "assistant" }] },
        text: "Hello!",
        toolCalls: [],
        toolResults: [],
      });
      const attemptCompleted = vi.fn();
      const hooks = createInstrumentationHooks([
        { events: { "step.attempt.completed": attemptCompleted }, name: "attempt" },
      ]);
      const runInContext: InstrumentationContextRunner = (_operation, execute) => execute();
      const config = createTestConfig(undefined, {
        instrumentation: bindHookInstrumentation(hooks, runInContext),
      });

      const runStep = createToolLoopHarness(config);
      await runStep(createTestSession(), { message: "hi" });

      expect(mockCreateAiSdkHookBridge).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          attemptId: "test-session:turn_0:0:0",
          attemptIndex: 0,
          sessionId: "test-session",
          stepIndex: 0,
          turnId: "turn_0",
        }),
        expect.objectContaining({
          capturesContent: false,
          capturesInputs: false,
          capturesOutputs: false,
        }),
        runInContext,
        {},
        expect.any(Function),
      );
      const bridge = mockCreateAiSdkHookBridge.mock.results[0]!.value;
      const agentCall = vi.mocked(ToolLoopAgent).mock.calls[0]?.[0] as {
        telemetry?: {
          integrations?: unknown[];
          recordInputs?: boolean;
          recordOutputs?: boolean;
        };
      };
      expect(agentCall.telemetry).toMatchObject({
        integrations: [bridge],
        recordInputs: false,
        recordOutputs: false,
      });
      expect(attemptCompleted).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          scope: expect.objectContaining({ attemptIndex: 0 }),
          type: "step.attempt.completed",
        }),
        expect.anything(),
      );
    });

    it("publishes a delegation action when the AI SDK skips execution callbacks", async () => {
      setupMockAgent({
        finishReason: "tool-calls",
        response: {
          messages: [
            {
              content: [
                {
                  input: { message: "research this" },
                  toolCallId: "call-delegate",
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
            input: { message: "research this" },
            toolCallId: "call-delegate",
            toolName: "delegate",
            type: "tool-call",
          },
        ],
        toolResults: [],
      });
      const started = vi.fn();
      const hooks = createInstrumentationHooks([
        { events: { "tool.call.started": started }, name: "actions" },
      ]);
      const { emit } = createEventCollector();
      const runStep = createToolLoopHarness(
        createTestConfig(emit, {
          instrumentation: bindHookInstrumentation(hooks),
          tools: createDelegationToolMap(),
        }),
      );

      await runStep(createTestSession(), { message: "delegate" });

      expect(started).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          callId: "call-delegate",
          kind: "tool-call",
          toolName: "delegate",
          type: "tool.call.started",
        }),
        expect.anything(),
      );
    });

    it("composes the bridge with every registered integration", async () => {
      setupMockAgent({
        finishReason: "stop",
        response: { messages: [{ content: "Hello!", role: "assistant" }] },
        text: "Hello!",
        toolCalls: [],
        toolResults: [],
      });
      declareTelemetry({ recordInputs: true, recordOutputs: false }, undefined, "public");
      // An authored module can register its own integration alongside eve's.
      mockGetRegisteredTelemetryIntegrations.mockReturnValue([
        registeredOtelIntegration,
        registeredAuthorIntegration,
      ]);
      const runStep = createToolLoopHarness(
        createTestConfig(undefined, {
          instrumentation: declaredInstrumentation,
        }),
      );

      const ctx = new ContextContainer();
      setConversationContext(ctx, "public", "channel:public");
      await contextStorage.run(ctx, () => runStep(createTestSession(), { message: "hi" }));

      const bridge = mockCreateAiSdkHookBridge.mock.results[0]!.value;
      const agentCall = vi.mocked(ToolLoopAgent).mock.calls[0]?.[0] as {
        telemetry?: {
          integrations?: unknown[];
          recordInputs?: boolean;
          recordOutputs?: boolean;
        };
      };
      expect(agentCall.telemetry).toMatchObject({
        integrations: [bridge, registeredOtelIntegration, registeredAuthorIntegration],
        recordInputs: true,
        recordOutputs: false,
      });
    });

    it("emits hosted unknown model telemetry without content", async () => {
      setupMockAgent({
        finishReason: "stop",
        response: { messages: [{ content: "Hello!", role: "assistant" }] },
        text: "Hello!",
        toolCalls: [],
        toolResults: [],
      });
      declareTelemetry({ recordInputs: true, recordOutputs: true });

      const runStep = createToolLoopHarness(createTestConfig());
      await runStep(createTestSession(), { message: "hi" });

      const agentCall = vi.mocked(ToolLoopAgent).mock.calls[0]?.[0] as {
        telemetry?: { recordInputs?: boolean; recordOutputs?: boolean };
      };
      expect(agentCall.telemetry).toMatchObject({
        recordInputs: false,
        recordOutputs: false,
      });
    });

    it("keeps unknown model telemetry content in development", async () => {
      setupMockAgent({
        finishReason: "stop",
        response: { messages: [{ content: "Hello!", role: "assistant" }] },
        text: "Hello!",
        toolCalls: [],
        toolResults: [],
      });
      declareTelemetry(
        {
          recordInputs: true,
          recordOutputs: true,
          tracePolicy: () => true,
        },
        undefined,
        "unknown",
        "development",
      );

      const runStep = createToolLoopHarness(createTestConfig());
      await runStep(createTestSession(), { message: "hi" });

      const agentCall = vi.mocked(ToolLoopAgent).mock.calls[0]?.[0] as {
        telemetry?: { recordInputs?: boolean; recordOutputs?: boolean };
      };
      expect(agentCall.telemetry).toMatchObject({
        recordInputs: true,
        recordOutputs: true,
      });
    });

    it("merges runtime context before emitting step.started", async () => {
      const logs = captureLogRecords();
      setupMockAgent({
        finishReason: "stop",
        response: { messages: [{ content: "Hello!", role: "assistant" }] },
        text: "Hello!",
        toolCalls: [],
        toolResults: [],
      });

      const order: string[] = [];
      const events: UnstampedMessageStreamEvent[] = [];
      const emit: HarnessEmitFn = async (event) => {
        order.push(event.type);
        events.push(event);
      };
      const resolveRuntimeContext = vi.fn((input: InstrumentationStepStartedEventInput) => {
        order.push("runtimeContext");
        if (input.channel.kind !== "channel:support") {
          throw new Error("expected support channel metadata");
        }
        return {
          "eve.session.id": "user-override",
          "slack.user_id":
            typeof input.channel.metadata["triggeringUserId"] === "string"
              ? input.channel.metadata["triggeringUserId"]
              : "",
          "turn.id": input.turn.id,
        };
      });
      declareTelemetry(
        {
          runtimeContext: resolveRuntimeContext,
        },
        undefined,
        "public",
      );

      const ctx = new ContextContainer();
      setConversationContext(ctx, "public", "channel:support", {
        triggeringUserId: "U123",
      });

      const hidden = {
        content: "HIDE_FROM_INSTRUMENTATION",
        kind: "user" as const,
        role: "user" as const,
      };
      const config = createTestConfig(emit, {
        historyProjector: ({ messages }) => messages.filter((message) => message !== hidden),
      });
      const runStep = createToolLoopHarness(config);
      await contextStorage.run(ctx, () =>
        runStep(
          createTestSession({
            history: [{ content: "visible", kind: "user" as const, role: "user" }, hidden],
          }),
          { message: "hi" },
        ),
      );

      const agentCall = vi.mocked(ToolLoopAgent).mock.calls[0]?.[0] as {
        runtimeContext?: Record<string, unknown>;
        telemetry?: { includeRuntimeContext?: Record<string, boolean> };
      };
      expect(resolveRuntimeContext).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          modelInput: expect.objectContaining({
            messages: [
              { content: "visible", kind: "user" as const, role: "user" },
              { content: "hi", kind: "user" as const, role: "user" },
            ],
          }),
          step: { index: 0 },
          turn: { id: "turn_0", sequence: 0 },
        }),
      );
      expect(agentCall?.runtimeContext).toEqual({
        "eve.environment": "test",
        "slack.user_id": "U123",
        "turn.id": "turn_0",
      });
      expect(agentCall?.telemetry?.includeRuntimeContext).toEqual(
        Object.fromEntries(Object.keys(agentCall?.runtimeContext ?? {}).map((key) => [key, true])),
      );
      expect(order.indexOf("turn.started")).toBeLessThan(order.indexOf("runtimeContext"));
      expect(order.indexOf("step.started")).toBeLessThan(order.indexOf("runtimeContext"));
      expect(getCompatibilityEventTypes(events)).toContain("step.started");
      expect(logs.records).toContainEqual(
        expect.objectContaining({
          level: "warn",
          message: "ignoring reserved instrumentation runtime context key",
        }),
      );
    });

    it("continues the normal turn flow when runtime context throws", async () => {
      const logs = captureLogRecords();
      setupMockAgent({
        finishReason: "stop",
        response: { messages: [{ content: "Hello!", role: "assistant" }] },
        text: "Hello!",
        toolCalls: [],
        toolResults: [],
      });

      declareTelemetry({
        runtimeContext: () => {
          throw new Error("runtime context resolver failed");
        },
      });

      const { emit, events } = createEventCollector();
      const runStep = createToolLoopHarness(createTestConfig(emit));
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
      expect(agentCall?.runtimeContext).toEqual({
        "eve.environment": "test",
      });
      expect(logs.records).toContainEqual(
        expect.objectContaining({
          level: "warn",
          message: "ignoring instrumentation projection after projector failure",
        }),
      );
    });

    it("resolves runtime context for each step and turn coordinate", async () => {
      const resolveRuntimeContext = vi.fn((input: InstrumentationStepStartedEventInput) => ({
        "test.step": `${input.turn.id}:${input.step.index}`,
      }));
      declareTelemetry({
        runtimeContext: resolveRuntimeContext,
      });

      const { emit } = createEventCollector();
      const config = createTestConfig(emit);
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

      const config = createTestConfig();
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
      expect(historyRef.path).toMatch(/^\/workspace\/\.eve\/attachments\/[0-9a-f]{16}\/logo\.png$/);

      // --- Invariant 3: the mocked ToolLoopAgent.stream saw hydrated bytes.
      //
      // The mock constructor ran once; grab the stream spy and verify the
      // messages it received had `data: Buffer` for the FilePart.
      const mockInstance = vi.mocked(ToolLoopAgent).mock.results[0]?.value as {
        stream: ReturnType<typeof vi.fn>;
      };
      expect(mockInstance).toBeDefined();
      const modelCall = mockInstance.stream.mock.calls[0]?.[0] as {
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

    it("keeps tool-result files out of history and hydrates identical bytes on every later call", async () => {
      const base64 = pngBytes(64, 64, 2048).toString("base64");
      const file = {
        data: { data: base64, type: "data" as const },
        filename: "chart.png",
        mediaType: "image/png",
        type: "file" as const,
      };
      const toolCall = {
        input: {},
        toolCallId: "render-1",
        toolName: "render_chart",
        type: "tool-call" as const,
      };
      const toolResult = {
        output: { type: "content" as const, value: [file] },
        toolCallId: "render-1",
        toolName: "render_chart",
        type: "tool-result" as const,
      };
      const reply = (text: string) => ({
        finishReason: "stop",
        response: { messages: [{ content: text, role: "assistant" }] },
        text,
        toolCalls: [],
        toolResults: [],
      });
      setupMockAgentSequence([
        {
          finishReason: "tool-calls",
          response: {
            messages: [
              { content: [toolCall], role: "assistant" },
              { content: [toolResult], role: "tool" },
            ],
          },
          text: "",
          toolCalls: [toolCall],
          toolResults: [toolResult],
        },
        reply("A bar chart."),
        reply("Still a bar chart."),
      ]);
      const sandbox = mockSandbox({ id: "sbx_tool_media" });
      const ctx = new ContextContainer();
      ctx.set(SandboxKey, sandbox.access);
      const runStep = createToolLoopHarness(createTestConfig());

      const first = await contextStorage.run(ctx, () =>
        runStep(createTestSession(), { message: "Render the chart." }),
      );
      if (typeof first.next !== "function") throw new Error("Expected a tool continuation.");
      const next = first.next;
      const second = await contextStorage.run(ctx, () => next(first.session));
      const third = await contextStorage.run(ctx, () =>
        runStep(second.session, { message: "Describe it again." }),
      );

      expect(sandbox.writes).toHaveLength(1);
      expect(JSON.stringify(third.session.history)).not.toContain(base64);
      // The next step and the next turn both render the file exactly as the
      // tool returned it, so the provider sees a stable prompt prefix.
      const laterCalls = vi
        .mocked(ToolLoopAgent)
        .mock.results.slice(1)
        .map(
          (result) =>
            (result.value as { stream: ReturnType<typeof vi.fn> }).stream.mock.calls[0]?.[0] as {
              messages: ModelMessage[];
            },
        );
      expect(laterCalls).toHaveLength(2);
      for (const call of laterCalls) {
        expect(call.messages.find((message) => message.role === "tool")?.content).toEqual([
          toolResult,
        ]);
      }
    });

    it("keeps files a workflow tool projects for the model out of history", async () => {
      const { withParkedStep } = await import("#internal/testing/session-machine.js");
      const { toolOutput, toolOutputPart } = await import("#tools/model-output.js");
      setupMockAgent({
        finishReason: "stop",
        response: { messages: [{ content: "Captured.", role: "assistant" }] },
        text: "Captured.",
        toolCalls: [],
        toolResults: [],
      });
      const base64 = pngBytes(32, 32, 512).toString("base64");
      const tools: ToolLoopHarnessConfig["tools"] = new Map([
        [
          "screenshot",
          {
            description: "Capture a screenshot.",
            inputSchema: jsonSchema({ type: "object" }),
            name: "screenshot",
            toModelOutput: (output: unknown) =>
              toolOutput.content([
                toolOutputPart.file((output as { png: string }).png, { mediaType: "image/png" }),
              ]),
            workflowId: "workflow//./agent/tools/screenshot//execute",
          },
        ],
      ]);
      const parked = withParkedStep(createTestSession(), {
        event: { sequence: 0, stepIndex: 0, turnId: "turn_0" },
        messages: [
          {
            content: [
              { input: {}, toolCallId: "shot-1", toolName: "screenshot", type: "tool-call" },
            ],
            role: "assistant",
          },
        ],
        tasks: [
          {
            callId: "shot-1",
            entry: { entryPoint: "execute" },
            input: {},
            kind: "workflow-task",
            toolName: "screenshot",
            workflowId: "workflow//./agent/tools/screenshot//execute",
          },
        ],
      });
      const sandbox = mockSandbox({ id: "sbx_workflow_media" });
      const ctx = new ContextContainer();
      ctx.set(SandboxKey, sandbox.access);

      const result = await contextStorage.run(ctx, () =>
        createToolLoopHarness(createTestConfig(undefined, { tools }))(parked, {
          runtimeActionResults: [
            {
              callId: "shot-1",
              kind: "tool-result",
              output: { png: base64 },
              toolName: "screenshot",
            },
          ],
        }),
      );

      expect(sandbox.writes).toHaveLength(1);
      expect(JSON.stringify(result.session.history)).not.toContain(base64);
      const agent = vi.mocked(ToolLoopAgent).mock.results[0]?.value as
        | { stream: ReturnType<typeof vi.fn> }
        | undefined;
      const modelCall = agent?.stream.mock.calls[0]?.[0] as { messages: ModelMessage[] };
      expect(JSON.stringify(modelCall.messages)).toContain(base64);
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

      const config = createTestConfig();
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
        stream: ReturnType<typeof vi.fn>;
      };
      const modelCall = mockInstance.stream.mock.calls[0]?.[0] as {
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

  describe("context routing", () => {
    function getLastAgentSettings(): {
      instructions: unknown;
      messages: Array<{ role: string; content: unknown }>;
    } {
      const settings = vi.mocked(ToolLoopAgent).mock.calls.at(-1)?.[0] as {
        instructions: unknown;
      };
      const instance = vi.mocked(ToolLoopAgent).mock.results.at(-1)?.value as {
        stream: ReturnType<typeof vi.fn>;
      };
      const call = instance.stream.mock.calls[0]?.[0] as {
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

    it("appends durable channel context as user messages", async () => {
      setupMockAgent(defaultModelResult());
      const runStep = createToolLoopHarness(createTestConfig());
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
      const runStep = createToolLoopHarness(createTestConfig());
      const session = createTestSession({
        history: [{ role: "system", content: "durable-system" }],
      });

      await runStep(session, { message: "Hi" });

      const { instructions, messages } = getLastAgentSettings();
      expect(instructions).toEqual({
        role: "system",
        content: "You are a test assistant.\n\ndurable-system",
      });
      expect(messages.find((m) => m.role === "system")).toBeUndefined();
      expect(messages.at(-1)).toEqual({ kind: "user" as const, role: "user", content: "Hi" });
    });

    it("persists context strings in session history as user messages", async () => {
      setupMockAgent(defaultModelResult());
      const runStep = createToolLoopHarness(createTestConfig());
      const session = createTestSession();

      const result = await runStep(session, {
        message: "Hi",
        context: ["background-context"],
      });

      expect(result.session.history).toEqual([
        { role: "user", content: "background-context", kind: "context.instruction" },
        { kind: "user" as const, role: "user", content: "Hi" },
        { role: "assistant", content: "ok" },
      ]);
    });

    it("does not replay ephemeral client context on later turns", async () => {
      setupMockAgent(defaultModelResult());
      const runStep = createToolLoopHarness(createTestConfig());
      let session = createTestSession();

      for (const token of ["CTX-A", "CTX-B", "CTX-C"]) {
        const clientContext = `Client context:\n${token}`;
        const result = await runStep(
          session,
          attachClientContext({ message: `Turn ${token}` }, [clientContext]),
        );
        const visibleClientContext = getLastAgentSettings().messages.filter(
          (message) =>
            typeof message.content === "string" && message.content.startsWith("Client context:"),
        );

        expect(visibleClientContext).toEqual([
          { content: clientContext, kind: "context.instruction", role: "user" },
        ]);
        expect(result.session.history).not.toContainEqual({
          content: clientContext,
          kind: "user" as const,
          role: "user",
        });
        session = result.session;
      }
    });

    it("keeps client context at a stable prompt position through every step of its turn", async () => {
      const toolCallMessage = {
        content: [
          {
            input: { a: 20, b: 22 },
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
            output: "42",
            toolCallId: "call-1",
            toolName: "add",
            type: "tool-result",
          },
        ],
        role: "tool",
      } as const;
      setupMockAgent({
        finishReason: "tool-calls",
        response: { messages: [toolCallMessage, toolResultMessage] },
        text: "",
        toolCalls: toolCallMessage.content,
        toolResults: [
          {
            input: { a: 20, b: 22 },
            output: "42",
            toolCallId: "call-1",
            toolName: "add",
            type: "tool-result",
          },
        ],
      });
      const runStep = createToolLoopHarness(createTestConfig());
      const clientContext = "Client context:\nroute=/billing";

      const firstStep = await runStep(
        createTestSession(),
        attachClientContext({ message: "Add 20 and 22." }, [clientContext]),
      );
      expect(firstStep.next).toBe(runStep);
      const firstPrompt = structuredClone(getLastAgentSettings().messages);

      setupMockAgent(defaultModelResult());
      const serializedSession = JSON.parse(JSON.stringify(firstStep.session)) as HarnessSession;
      const secondStep = await runStep(serializedSession);
      expect(secondStep.next).toBeNull();
      const secondPrompt = getLastAgentSettings().messages;

      expect(secondPrompt.slice(0, firstPrompt.length)).toEqual(firstPrompt);
      expect(secondPrompt).toEqual([
        { content: clientContext, kind: "context.instruction", role: "user" },
        { content: "Add 20 and 22.", kind: "user" as const, role: "user" },
        toolCallMessage,
        toolResultMessage,
      ]);
      expect(secondStep.session.history).not.toContainEqual({
        content: clientContext,
        kind: "user" as const,
        role: "user",
      });
      expect(JSON.stringify(secondStep.session.state)).not.toContain(clientContext);

      setupMockAgent(defaultModelResult());
      await runStep(secondStep.session, { message: "Start another turn." });
      expect(getLastAgentSettings().messages).not.toContainEqual({
        content: clientContext,
        kind: "user" as const,
        role: "user",
      });
    });

    it("keeps ephemeral client context out of compaction and its token baseline", async () => {
      vi.mocked(shouldCompact).mockReturnValueOnce(true);
      vi.mocked(compactMessages).mockImplementationOnce(async (messages) => [...messages]);
      setupMockAgent({
        ...defaultModelResult(),
        usage: { inputTokens: 321 },
      });
      const runStep = createToolLoopHarness(createTestConfig());
      const session = createTestSession({
        history: [{ content: "earlier", kind: "user" as const, role: "user" }],
      });

      const result = await runStep(
        session,
        attachClientContext({ message: "Hi" }, ["Client context:\ncurrent"]),
      );

      expect(vi.mocked(shouldCompact)).toHaveBeenCalledWith(
        [
          { content: "earlier", kind: "user" as const, role: "user" },
          { content: "Client context:\ncurrent", kind: "context.instruction", role: "user" },
          { content: "Hi", kind: "user" as const, role: "user" },
        ],
        session.compaction,
        expect.any(Number),
        undefined,
      );
      expect(vi.mocked(compactMessages).mock.calls[0]?.[0]).toEqual([
        { content: "earlier", kind: "user" as const, role: "user" },
        { content: "Hi", kind: "user" as const, role: "user" },
      ]);
      expect(result.session.history).not.toContainEqual({
        content: "Client context:\ncurrent",
        kind: "user" as const,
        role: "user",
      });
      expect(result.session.compaction).not.toHaveProperty("lastKnownInputTokens");
      expect(result.session.compaction).not.toHaveProperty("lastKnownPromptMessageCount");
    });

    it("leaves instructions unchanged when no context is provided", async () => {
      setupMockAgent(defaultModelResult());
      const runStep = createToolLoopHarness(createTestConfig());
      const session = createTestSession();

      await runStep(session, { message: "Hi" });

      const { instructions } = getLastAgentSettings();
      expect(instructions).toBe("You are a test assistant.");
    });

    it("routes dynamic instruction messages from durable keys into instructions", async () => {
      setupMockAgent(defaultModelResult());
      const runStep = createToolLoopHarness(createTestConfig());
      const session = createTestSession();

      const ctx = new ContextContainer();
      ctx.set(SessionDynamicInstructionsKey, {
        context: [{ role: "system" as const, content: "dynamic-system-instruction" }],
      });
      const userContent: UserContent = [{ type: "text", text: "Hi" }];

      await contextStorage.run(ctx, () => runStep(session, { message: userContent }));

      const { instructions, messages } = getLastAgentSettings();
      expect(instructions).toEqual({
        role: "system",
        content: "You are a test assistant.\n\ndynamic-system-instruction",
      });
      expect(messages.find((m) => m.content === "dynamic-system-instruction")).toBeUndefined();
      expect(messages.at(-1)?.content).toEqual(userContent);
    });

    it("commits dynamic user instructions before the current delivery in model history", async () => {
      setupMockAgent(defaultModelResult());
      const ctx = new ContextContainer();
      ctx.set(SessionIdKey, "test-session");
      const snapshots: string[][] = [];
      const resolver: ResolvedDynamicInstructionsResolver = {
        eventNames: ["session.started", "turn.started"],
        events: {
          "session.started": (_event, rawCtx) => {
            const resolveCtx = rawCtx as DynamicResolveContext;
            snapshots.push(resolveCtx.messages.map((message) => String(message.content)));
            return defineInstructions({ content: "Session context.", role: "user" });
          },
          "turn.started": (_event, rawCtx) => {
            const resolveCtx = rawCtx as DynamicResolveContext;
            snapshots.push(resolveCtx.messages.map((message) => String(message.content)));
            return defineInstructions({ content: "Turn context.", role: "user" });
          },
        },
        logicalPath: "instructions/context.ts",
        slug: "context",
        sourceId: "instructions/context.ts",
        sourceKind: "module",
      };
      const handleEvent: HarnessEmitFn = async (event, messages) => {
        if (event.type !== "session.started" && event.type !== "turn.started") return;
        await resolveDynamicInstructions({
          ctx,
          event,
          messages: messages ?? [],
          resolvers: [resolver],
        });
      };
      const hidden = {
        content: "Hidden context.",
        kind: "user" as const,
        role: "user" as const,
      };
      const runStep = createToolLoopHarness(
        createTestConfig(handleEvent, {
          historyProjector: ({ messages }) => messages.filter((message) => message !== hidden),
        }),
      );
      const session = createTestSession({
        history: [{ content: "Static context.", kind: "user" as const, role: "user" }, hidden],
      });

      const result = await contextStorage.run(ctx, () => runStep(session, { message: "Hello." }));

      expect(snapshots).toEqual([["Static context."], ["Static context.", "Session context."]]);
      expect(getLastAgentSettings().instructions).toBe("You are a test assistant.");
      expect(getLastAgentSettings().messages).toEqual([
        { content: "Static context.", kind: "user" as const, role: "user" },
        { content: "Session context.", kind: "context.instruction", role: "user" },
        { content: "Turn context.", kind: "context.instruction", role: "user" },
        { content: "Hello.", kind: "user" as const, role: "user" },
      ]);
      expect(result.session.history).toEqual([
        { content: "Static context.", kind: "user" as const, role: "user" },
        hidden,
        { content: "Session context.", kind: "context.instruction", role: "user" },
        { content: "Turn context.", kind: "context.instruction", role: "user" },
        { content: "Hello.", kind: "user" as const, role: "user" },
        { content: "ok", role: "assistant" },
      ]);
    });

    it("preserves the Anthropic system cache breakpoint when merging instructions", async () => {
      setupMockAgent(defaultModelResult());
      const runStep = createToolLoopHarness(
        createTestConfig(undefined, {
          resolveModel: vi.fn().mockResolvedValue(
            new MockLanguageModelV3({
              modelId: "claude-sonnet-4-5",
              provider: "anthropic.messages",
            }),
          ),
        }),
      );
      const session = createTestSession();
      const ctx = new ContextContainer();
      ctx.set(SessionDynamicInstructionsKey, {
        context: [{ role: "system" as const, content: "dynamic-system-instruction" }],
      });

      await contextStorage.run(ctx, () => runStep(session, { message: "Hi" }));

      expect(getLastAgentSettings().instructions).toEqual({
        role: "system",
        content: "You are a test assistant.\n\ndynamic-system-instruction",
        providerOptions: {
          anthropic: { cacheControl: { type: "ephemeral" } },
          bedrock: { cachePoint: { type: "default" } },
        },
      });
    });

    it("does not persist dynamic instruction messages to session history", async () => {
      setupMockAgent(defaultModelResult());
      const runStep = createToolLoopHarness(createTestConfig());
      const session = createTestSession();

      const ctx = new ContextContainer();
      ctx.set(SessionDynamicInstructionsKey, {
        context: [{ role: "system" as const, content: "dynamic-sys" }],
      });

      const result = await contextStorage.run(ctx, () => runStep(session, { message: "Hi" }));

      expect(result.session.history).toEqual([
        { kind: "user" as const, role: "user", content: "Hi" },
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
      await createToolLoopHarness(createTestConfig())(createTestSession(), {
        message: "Hi",
      });
    }

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

describe("appendMissingToolResultMessages", () => {
  const searchResult = {
    type: "tool-result" as const,
    toolCallId: "toolu_1",
    toolName: "web_search",
    output: { type: "json" as const, value: { winner: "OKC" } },
  };

  it("skips synthesized results for provider-executed calls already answered inline", () => {
    // Provider-executed results live inside the *assistant* message until
    // provider history normalization; a second result for the same id makes
    // Anthropic reject the whole history on the next call.
    const assistantWithInlineResult = {
      role: "assistant" as const,
      content: [
        {
          type: "tool-call" as const,
          toolCallId: "toolu_1",
          toolName: "web_search",
          input: { query: "2025 NBA Finals" },
          providerExecuted: true,
        },
        { ...searchResult, providerExecuted: true },
      ],
    };

    const messages = appendMissingToolResultMessages({
      append: [
        {
          type: "tool-result",
          toolCallId: "toolu_1",
          toolName: "web_search",
          output: { type: "error-text", value: "Failed to parse tool-call arguments" },
        },
      ],
      responseMessages: [assistantWithInlineResult],
    });

    expect(messages).toEqual([assistantWithInlineResult]);
  });

  it("still backfills calls with no result anywhere", () => {
    const assistant = {
      role: "assistant" as const,
      content: [
        {
          type: "tool-call" as const,
          toolCallId: "toolu_2",
          toolName: "web_search",
          input: {},
        },
      ],
    };
    const backfill = {
      type: "tool-result" as const,
      toolCallId: "toolu_2",
      toolName: "web_search",
      output: { type: "error-text" as const, value: "invalid input" },
    };

    expect(
      appendMissingToolResultMessages({ append: [backfill], responseMessages: [assistant] }),
    ).toEqual([assistant, { role: "tool", content: [backfill] }]);
  });

  it("answers a response's calls in one tool message, in the order the model made them", () => {
    const call = (toolCallId: string) => ({
      type: "tool-call" as const,
      toolCallId,
      toolName: "file_pages",
      input: {},
    });
    const result = (toolCallId: string) => ({
      type: "tool-result" as const,
      toolCallId,
      toolName: "file_pages",
      output: { type: "json" as const, value: toolCallId },
    });
    const assistant = {
      role: "assistant" as const,
      content: [call("valid"), call("invalid"), call("authored")],
    };
    // The AI SDK answers the invalid call as the response streams; the others run after it ends.
    const sdkAnswered = { role: "tool" as const, content: [result("invalid")] };

    expect(
      appendMissingToolResultMessages({
        append: [result("valid"), result("authored")],
        responseMessages: [assistant, sdkAnswered],
      }),
    ).toEqual([
      assistant,
      { role: "tool", content: [result("valid"), result("invalid"), result("authored")] },
    ]);
  });

  it("dedupes against results already in tool messages", () => {
    const toolMessage = { role: "tool" as const, content: [searchResult] };
    expect(
      appendMissingToolResultMessages({
        append: [searchResult],
        responseMessages: [toolMessage],
      }),
    ).toEqual([toolMessage]);
  });
});

describe("boundary event failures", () => {
  it("keeps runtime preamble failures terminal", async () => {
    const failure = new Error("memory recall failed");
    const emit: HarnessEmitFn = async (event) => {
      if (event.type === "turn.started") throw failure;
    };
    await expect(
      createToolLoopHarness(createTestConfig(emit))(createTestSession(), {
        message: "Hi",
      }),
    ).rejects.toBe(failure);
  });

  it("preserves explicit cancellation from a boundary handler", async () => {
    const cancellation = new TurnCancelledError();
    const emit: HarnessEmitFn = async () => {
      throw cancellation;
    };
    await expect(
      createToolLoopHarness(createTestConfig(emit))(createTestSession(), {
        message: "Hi",
      }),
    ).rejects.toBe(cancellation);
  });
});

/** Participants that only choose the model, through `selectModel`. */
function modelParticipants(selectModel: StepParticipants["selectModel"]): StepParticipants {
  return { restoreStep: async () => {}, selectModel };
}
