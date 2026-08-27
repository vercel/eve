import { SpanKind, SpanStatusCode, trace as apiTrace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it, vi } from "vitest";

import {
  ROOT_CONTEXT,
  context,
  trace as runtimeTrace,
} from "#compiled/@opentelemetry/api/index.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { createAiSdkHookBridge } from "#harness/ai-sdk-hook-bridge.js";
import {
  createAgentOtelInstrumentation,
  type AgentOtelInstrumentationInput,
} from "#tracing/agent-otel-provider.js";
import { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";
import { ContextAgentTraceStateStore } from "#tracing/agent-trace-context-store.js";
import {
  type AgentTraceStateStore,
  InMemoryAgentTraceStateStore,
} from "#tracing/agent-trace-state.js";
import {
  createInstrumentationHooks,
  type InstrumentationActionKind,
  type InstrumentationAttemptScope,
  type InstrumentationContextRunner,
  type InstrumentationHooks,
  type InstrumentationParentLineage,
  type InstrumentationTraceContext,
  type InstrumentationUsage,
} from "#harness/instrumentation/lifecycle.js";
import type { ChannelAudience } from "#shared/channel-audience.js";
import type { TraceCapturePolicy } from "#tracing/otel-declaration.js";
import {
  actionIdempotencyKey,
  attemptIdempotencyKey,
  inputIdempotencyKey,
  modelCallIdempotencyKey,
  sessionIdempotencyKey,
  turnIdempotencyKey,
} from "#harness/instrumentation/lifecycle.js";

interface TestRuntime {
  readonly exporter: InMemorySpanExporter;
  readonly hooks: InstrumentationHooks;
  readonly provider: BasicTracerProvider;
  readonly prepareSessionTrace: ReturnType<
    typeof createAgentOtelInstrumentation
  >["prepareSessionTrace"];
  readonly prepareTurnTrace: ReturnType<typeof createAgentOtelInstrumentation>["prepareTurnTrace"];
  readonly runInContext: InstrumentationContextRunner;
  readonly tracer: ReturnType<BasicTracerProvider["getTracer"]>;
}

function createRuntime(
  stateStore: AgentTraceStateStore = new InMemoryAgentTraceStateStore(),
  tracePolicy: TraceCapturePolicy | null = () => true,
): TestRuntime {
  const exporter = new InMemorySpanExporter();
  const idGenerator = new AgentSpanIdGenerator();
  const provider = new BasicTracerProvider({
    idGenerator,
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const tracer = provider.getTracer("eve.agent");
  const agentOtelInput: Omit<AgentOtelInstrumentationInput, "tracePolicy"> & {
    tracePolicy?: TraceCapturePolicy;
  } = {
    frameworkVersion: "test",
    idGenerator,
    recordInputs: true,
    recordOutputs: true,
    stateStore,
    tracer,
  };
  if (tracePolicy !== null) agentOtelInput.tracePolicy = tracePolicy;
  const agentOtel = createAgentOtelInstrumentation(agentOtelInput);
  const hooks = createInstrumentationHooks([agentOtel.hook]);
  return {
    exporter,
    hooks,
    prepareSessionTrace: agentOtel.prepareSessionTrace,
    prepareTurnTrace: agentOtel.prepareTurnTrace,
    provider,
    runInContext: agentOtel.runInContext,
    tracer,
  };
}

async function emitAttempt(input: {
  readonly actionUsage?: InstrumentationUsage;
  readonly attemptIndex?: number;
  readonly attemptError?: Error;
  readonly channelAudience?: ChannelAudience;
  readonly hooks: InstrumentationHooks;
  readonly parentLineage?: InstrumentationParentLineage;
  readonly parentTraceContext?: InstrumentationTraceContext;
  readonly runInContext: InstrumentationContextRunner;
  readonly providerMetadata?: Readonly<Record<string, unknown>>;
  readonly actionKind?: InstrumentationActionKind;
  readonly runtimeContext?: Readonly<Record<string, unknown>>;
  readonly sessionId: string;
  readonly skipModelTerminal?: boolean;
  readonly skipToolTerminal?: boolean;
  readonly toolError?: Error;
  readonly turnAlreadyStarted?: boolean;
  readonly turnId: string;
  readonly turnSequence: number;
}): Promise<void> {
  const scope: InstrumentationAttemptScope = {
    attemptId: `${input.sessionId}:${input.turnId}:0:${input.attemptIndex ?? 0}`,
    attemptIndex: input.attemptIndex ?? 0,
    channelAudience: input.channelAudience,
    functionId: "weather",
    sessionId: input.sessionId,
    stepIndex: 0,
    turnId: input.turnId,
  };
  if (input.turnAlreadyStarted !== true) {
    await publishTurnStarted(input);
  }

  const bridge = createAiSdkHookBridge(
    scope,
    input.hooks,
    input.runInContext,
    input.runtimeContext,
  );
  Reflect.apply(bridge.onStart!, bridge, [
    {
      callId: "call-1",
      instructions: "private prompt",
      messages: [{ content: "private message", role: "user" }],
      modelId: "claude-test",
      operationId: "ai.streamText",
      provider: "anthropic",
    },
  ]);
  await Reflect.apply(bridge.onStepStart!, bridge, [{ callId: "call-1", stepNumber: 0 }]);
  await Reflect.apply(bridge.onLanguageModelCallStart!, bridge, [
    {
      callId: "call-1",
      instructions: "You are a weather assistant (system prompt).",
      messages: [
        {
          content: "real user text",
          providerOptions: { anthropic: { signature: "sig-blob" } },
          role: "user",
        },
      ],
      modelId: "claude-test",
      provider: "anthropic",
    },
  ]);
  await bridge.executeLanguageModelCall!({ callId: "call-1", execute: async () => undefined });
  if (input.skipModelTerminal !== true) {
    await Reflect.apply(bridge.onLanguageModelCallEnd!, bridge, [
      {
        callId: "call-1",
        content: [
          { type: "reasoning", text: "thinking about weather" },
          { type: "text", text: "Checking the weather." },
          {
            input: { query: "weather today" },
            providerExecuted: true,
            toolCallId: "search-1",
            toolName: "web_search",
            type: "tool-call",
          },
          {
            input: { query: "weather today" },
            output: { results: ["sunny"] },
            providerExecuted: true,
            toolCallId: "search-1",
            toolName: "web_search",
            type: "tool-result",
          },
        ],
        finishReason: "tool-calls",
        performance: { responseTimeMs: 10 },
        responseId: "response-1",
        usage: {
          inputTokenDetails: { cacheReadTokens: 4, cacheWriteTokens: 2 },
          inputTokens: 10,
          outputTokens: 5,
        },
      },
    ]);
  }
  const actionKey = actionIdempotencyKey(input.sessionId, input.turnId, "tool-1");
  await input.hooks.publish({
    callId: "tool-1",
    idempotencyKey: actionKey,
    input: { secret: "value" },
    kind: input.actionKind ?? "tool-call",
    name: "weather",
    scope,
    type: "action.started",
  });
  await Reflect.apply(bridge.onToolExecutionStart!, bridge, [
    {
      callId: "call-1",
      toolCall: { input: { secret: "value" }, toolCallId: "tool-1", toolName: "weather" },
    },
  ]);
  await bridge.executeTool!({
    callId: "call-1",
    execute: async () => undefined,
    toolCallId: "tool-1",
  });
  if (input.skipToolTerminal !== true) {
    await Reflect.apply(bridge.onToolExecutionEnd!, bridge, [
      {
        callId: "call-1",
        messages: [],
        toolCall: { input: {}, toolCallId: "tool-1", toolName: "weather" },
        toolExecutionMs: 1,
        toolOutput:
          input.toolError === undefined
            ? { output: { temperature: 72 }, type: "tool-result" }
            : { error: input.toolError, type: "tool-error" },
      },
    ]);
    await input.hooks.publish(
      input.toolError === undefined
        ? {
            idempotencyKey: actionKey,
            outcome: "completed",
            output: { output: { temperature: 72 }, type: "result" },
            scope,
            type: "action.completed",
            usage: input.actionUsage,
          }
        : {
            error: input.toolError,
            errorCode: "TOOL_CALL_FAILED",
            idempotencyKey: actionKey,
            outcome: "failed",
            scope,
            type: "action.failed",
          },
    );
  }

  if (input.providerMetadata !== undefined) {
    await input.hooks.publish({
      idempotencyKey: attemptIdempotencyKey(scope),
      providerMetadata: input.providerMetadata,
      scope,
      type: "step.attempt.metadata",
    });
  }

  await input.hooks.publish(
    input.attemptError === undefined
      ? {
          idempotencyKey: attemptIdempotencyKey(scope),
          scope,
          type: "step.attempt.completed",
        }
      : {
          error: input.attemptError,
          idempotencyKey: attemptIdempotencyKey(scope),
          scope,
          type: "step.attempt.failed",
        },
  );
  await input.hooks.publish({
    idempotencyKey: turnIdempotencyKey(input.sessionId, input.turnId),
    sessionId: input.sessionId,
    turnId: input.turnId,
    type: "turn.completed",
  });
  await input.hooks.publish({
    idempotencyKey: sessionIdempotencyKey(input.sessionId),
    sessionId: input.sessionId,
    turnId: input.turnId,
    type: "session.waiting",
  });
}

async function publishTurnStarted(input: {
  readonly channelAudience?: ChannelAudience;
  readonly hooks: InstrumentationHooks;
  readonly parentLineage?: InstrumentationParentLineage;
  readonly parentTraceContext?: InstrumentationTraceContext;
  readonly rootSessionId?: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly turnSequence: number;
}): Promise<void> {
  const rootSessionId = input.rootSessionId ?? input.sessionId;
  await input.hooks.publish({
    agentName: "weather",
    channelAudience: input.channelAudience,
    channelKind: "http",
    idempotencyKey: sessionIdempotencyKey(input.sessionId),
    parentTraceContext: input.parentTraceContext,
    rootSessionId,
    sessionId: input.sessionId,
    type: "session.started",
  });
  await input.hooks.publish({
    idempotencyKey: turnIdempotencyKey(input.sessionId, input.turnId),
    parentLineage: input.parentLineage,
    parentTraceContext: input.parentTraceContext,
    rootSessionId,
    sequence: input.turnSequence,
    sessionId: input.sessionId,
    turnId: input.turnId,
    type: "turn.started",
  });
}

/** The turn span itself is emitted at the turn's session transition. */
async function completeTurn(
  hooks: InstrumentationHooks,
  sessionId: string,
  turnId: string,
): Promise<void> {
  await hooks.publish({
    idempotencyKey: turnIdempotencyKey(sessionId, turnId),
    sessionId,
    turnId,
    type: "turn.completed",
  });
  await hooks.publish({
    idempotencyKey: sessionIdempotencyKey(sessionId),
    sessionId,
    turnId,
    type: "session.waiting",
  });
}

function byName(spans: readonly ReadableSpan[], name: string): ReadableSpan[] {
  return spans.filter((span) => span.name === name);
}

function nanos(hrTime: readonly [number, number]): bigint {
  return BigInt(hrTime[0]) * 1_000_000_000n + BigInt(hrTime[1]);
}

describe("createAgentOtelInstrumentation", () => {
  it("prepares a stable stream trace before lifecycle hooks observe the turn", async () => {
    const runtime = createRuntime();
    const sessionEvent = {
      agentName: "weather",
      idempotencyKey: sessionIdempotencyKey("session-1"),
      rootSessionId: "session-1",
      sessionId: "session-1",
      type: "session.started" as const,
    };
    const turnEvent = {
      idempotencyKey: turnIdempotencyKey("session-1", "turn-1"),
      rootSessionId: "session-1",
      sequence: 0,
      sessionId: "session-1",
      turnId: "turn-1",
      type: "turn.started" as const,
    };

    const sessionTrace = await runtime.prepareSessionTrace(sessionEvent);
    const turnTrace = await runtime.prepareTurnTrace(turnEvent);
    await runtime.hooks.publish(sessionEvent);
    await runtime.hooks.publish(turnEvent);
    const replayedTrace = await runtime.prepareTurnTrace(turnEvent);
    await completeTurn(runtime.hooks, "session-1", "turn-1");
    await runtime.provider.forceFlush();

    expect(turnTrace).toEqual(sessionTrace);
    expect(replayedTrace).toEqual(turnTrace);
    const spans = runtime.exporter.getFinishedSpans();
    const session = byName(spans, "agent.session")[0]!;
    const turn = byName(spans, "agent.turn")[0]!;
    expect(session.spanContext()).toMatchObject(turnTrace);
    expect(turn.spanContext().traceId).toBe(turnTrace.traceId);
    expect(turn.parentSpanContext?.spanId).toBe(turnTrace.spanId);
  });

  it("uses the pre-allocated trace seed's trace id for agent.session", async () => {
    const runtime = createRuntime();
    const seed: InstrumentationTraceContext = {
      spanId: "a".repeat(16),
      traceFlags: 1,
      traceId: "b".repeat(32),
    };
    const sessionEvent = {
      agentName: "weather",
      idempotencyKey: sessionIdempotencyKey("session-seed"),
      rootSessionId: "session-seed",
      sessionId: "session-seed",
      traceSeed: seed,
      type: "session.started" as const,
    };

    await runtime.prepareSessionTrace(sessionEvent);
    await runtime.hooks.publish(sessionEvent);
    await runtime.provider.forceFlush();

    const spans = runtime.exporter.getFinishedSpans();
    const session = byName(spans, "agent.session")[0]!;
    expect(session.spanContext().traceId).toBe(seed.traceId);
    expect(session.spanContext().spanId).toBe(seed.spanId);
  });

  it("falls back to fresh ids when no trace seed is present", async () => {
    const runtime = createRuntime();
    const sessionEvent = {
      agentName: "weather",
      idempotencyKey: sessionIdempotencyKey("session-noseed"),
      rootSessionId: "session-noseed",
      sessionId: "session-noseed",
      type: "session.started" as const,
    };

    const trace = await runtime.prepareSessionTrace(sessionEvent);
    await runtime.hooks.publish(sessionEvent);
    await runtime.provider.forceFlush();

    const spans = runtime.exporter.getFinishedSpans();
    const session = byName(spans, "agent.session")[0]!;
    expect(session.spanContext().traceId).toBe(trace.traceId);
    // Fresh span id is random, not derived — just verify it matches the returned context.
    expect(session.spanContext().spanId).toBe(trace.spanId);
  });

  it("passes channelType to the policy on the seedless fallback path", async () => {
    let captured: { channelType?: string } | undefined;
    const runtime = createRuntime(undefined, (trace) => {
      captured = trace;
      return true;
    });
    const sessionEvent = {
      agentName: "weather",
      channelType: "slack",
      idempotencyKey: sessionIdempotencyKey("session-noseed-kind"),
      rootSessionId: "session-noseed-kind",
      sessionId: "session-noseed-kind",
      type: "session.started" as const,
    };

    await runtime.prepareSessionTrace(sessionEvent);

    expect(captured?.channelType).toBe("slack");
  });

  it("inherits parent trace context for delegated agents", async () => {
    const runtime = createRuntime();
    const parentTrace: InstrumentationTraceContext = {
      spanId: "c".repeat(16),
      traceFlags: 1,
      traceId: "d".repeat(32),
    };
    const sessionEvent = {
      agentName: "researcher",
      idempotencyKey: sessionIdempotencyKey("session-child"),
      parentTraceContext: parentTrace,
      rootSessionId: "root-session",
      sessionId: "session-child",
      type: "session.started" as const,
    };

    const trace = await runtime.prepareSessionTrace(sessionEvent);
    expect(trace.traceId).toBe(parentTrace.traceId);
    expect(trace.spanId).toBe(parentTrace.spanId);
  });

  it("treats the seed as authoritative when late policy would reject", async () => {
    const runtime = createRuntime(undefined, () => false);
    const seed: InstrumentationTraceContext = {
      spanId: "a".repeat(16),
      traceFlags: 1,
      traceId: "b".repeat(32),
    };
    const sessionEvent = {
      agentName: "weather",
      idempotencyKey: sessionIdempotencyKey("session-seed-authoritative"),
      rootSessionId: "session-seed-authoritative",
      sessionId: "session-seed-authoritative",
      traceSeed: seed,
      type: "session.started" as const,
    };

    await runtime.prepareSessionTrace(sessionEvent);
    await runtime.hooks.publish(sessionEvent);
    await runtime.provider.forceFlush();

    const spans = runtime.exporter.getFinishedSpans();
    const session = byName(spans, "agent.session")[0]!;
    expect(session.spanContext().traceId).toBe(seed.traceId);
    expect(session.spanContext().traceFlags).toBe(1);
  });

  it("treats an unsampled seed as authoritative when late policy would accept", async () => {
    const runtime = createRuntime();
    const seed: InstrumentationTraceContext = {
      spanId: "e".repeat(16),
      traceFlags: 0,
      traceId: "f".repeat(32),
    };
    const sessionEvent = {
      agentName: "weather",
      idempotencyKey: sessionIdempotencyKey("session-seed-unsampled"),
      rootSessionId: "session-seed-unsampled",
      sessionId: "session-seed-unsampled",
      traceSeed: seed,
      type: "session.started" as const,
    };

    await runtime.prepareSessionTrace(sessionEvent);
    await runtime.hooks.publish(sessionEvent);
    await runtime.provider.forceFlush();

    const spans = runtime.exporter.getFinishedSpans();
    expect(byName(spans, "agent.session")).toHaveLength(0);
  });

  it.each([
    ["cancelled", SpanStatusCode.UNSET],
    ["failed", SpanStatusCode.ERROR],
  ] as const)("records a %s channel delivery with the expected status", async (outcome, status) => {
    const runtime = createRuntime();
    const ctx = new ContextContainer();
    const delivery = {
      channelKind: "channel:slack",
      channelName: "slack",
      deliveryId: `delivery-${outcome}`,
    };
    const idempotencyKey = `channel-delivery:session-1:${delivery.deliveryId}`;

    await contextStorage.run(ctx, async () => {
      await runtime.hooks.publish({
        delivery,
        idempotencyKey,
        rootSessionId: "session-1",
        sessionId: "session-1",
        type: "channel.delivery.started",
      });
      await runtime.hooks.publish({
        delivery,
        error: outcome === "failed" ? new Error("failed") : undefined,
        errorCode: outcome === "failed" ? "CHANNEL_DELIVERY_FAILED" : undefined,
        idempotencyKey,
        outcome,
        rootSessionId: "session-1",
        sessionId: "session-1",
        type: `channel.delivery.${outcome}`,
      });
    });

    const span = runtime.exporter
      .getFinishedSpans()
      .find((candidate) => candidate.name === "agent.channel.delivery")!;
    expect(span.status.code).toBe(status);
    expect(span.attributes["error.type"]).toBe(
      outcome === "failed" ? "CHANNEL_DELIVERY_FAILED" : undefined,
    );
  });

  it("maps channel delivery under the session trace with an HTTP request link", async () => {
    const runtime = createRuntime();
    const ctx = new ContextContainer();
    const requestTraceContext = {
      spanId: "2222222222222222",
      traceFlags: 1,
      traceId: "22222222222222222222222222222222",
    };
    const started = {
      agentName: "support",
      delivery: {
        channelKind: "channel:slack",
        channelName: "slack",
        deliveryId: "delivery-1",
        requestId: "iad1::request-1",
        requestTraceContext,
      },
      idempotencyKey: "channel-delivery:session-1:delivery-1",
      input: { message: "private" },
      rootSessionId: "session-1",
      sessionId: "session-1",
      type: "channel.delivery.started" as const,
    };
    const completed = {
      agentName: started.agentName,
      delivery: started.delivery,
      idempotencyKey: started.idempotencyKey,
      outcome: "completed" as const,
      rootSessionId: started.rootSessionId,
      sequence: 0,
      sessionId: started.sessionId,
      turnId: "turn_0",
      type: "channel.delivery.completed" as const,
    };

    await contextStorage.run(ctx, async () => {
      await runtime.hooks.publish({
        agentName: "support",
        channelKind: "channel:slack",
        idempotencyKey: sessionIdempotencyKey("session-1"),
        rootSessionId: "session-1",
        sessionId: "session-1",
        type: "session.started",
      });
      await runtime.hooks.publish(started);
      await runtime.hooks.publish(completed);
    });

    const spans = runtime.exporter.getFinishedSpans();
    const session = spans.find((span) => span.name === "agent.session")!;
    const delivery = spans.find((span) => span.name === "agent.channel.delivery")!;
    expect(delivery.kind).toBe(SpanKind.CONSUMER);
    expect(delivery.parentSpanContext?.spanId).toBe(session.spanContext().spanId);
    expect(delivery.links).toEqual([
      expect.objectContaining({
        attributes: { "eve.link.type": "channel.request" },
        context: expect.objectContaining(requestTraceContext),
      }),
    ]);
    expect(delivery.attributes).toMatchObject({
      "agent.channel.delivery.id": "delivery-1",
      "agent.channel.delivery.input": JSON.stringify({ message: "private" }),
      "agent.channel.delivery.outcome": "completed",
      "agent.channel.kind": "channel:slack",
      "agent.channel.name": "slack",
      "agent.channel.request.id": "iad1::request-1",
      "agent.session.id": "session-1",
      "agent.turn.id": "turn_0",
      "agent.turn.sequence": 0,
    });

    await contextStorage.run(ctx, async () => {
      await runtime.hooks.publish(started);
      await runtime.hooks.publish(completed);
    });
    const replayed = runtime.exporter
      .getFinishedSpans()
      .filter((span) => span.name === "agent.channel.delivery");
    expect(replayed).toHaveLength(2);
    expect(replayed[1]!.spanContext().spanId).toBe(replayed[0]!.spanContext().spanId);
  });

  it("preserves a remote parent when delivery starts before the session event", async () => {
    const runtime = createRuntime();
    const ctx = new ContextContainer();
    const parentTraceContext = {
      isRemote: true as const,
      spanId: "2222222222222222",
      traceFlags: 1,
      traceId: "11111111111111111111111111111111",
    };
    const delivery = {
      channelKind: "http",
      channelName: "eve",
      deliveryId: "delivery-remote",
    };
    const idempotencyKey = `channel-delivery:remote-session:${delivery.deliveryId}`;

    await contextStorage.run(ctx, async () => {
      await runtime.hooks.publish({
        delivery,
        idempotencyKey,
        parentTraceContext,
        rootSessionId: "parent-session",
        sessionId: "remote-session",
        type: "channel.delivery.started",
      });
      await runtime.hooks.publish({
        agentName: "weather",
        channelKind: "http",
        idempotencyKey: sessionIdempotencyKey("remote-session"),
        parentTraceContext,
        rootSessionId: "parent-session",
        sessionId: "remote-session",
        type: "session.started",
      });
      await runtime.hooks.publish({
        idempotencyKey: turnIdempotencyKey("remote-session", "turn-remote"),
        parentTraceContext,
        rootSessionId: "parent-session",
        sequence: 0,
        sessionId: "remote-session",
        turnId: "turn-remote",
        type: "turn.started",
      });
      await runtime.hooks.publish({
        delivery,
        idempotencyKey,
        outcome: "completed",
        rootSessionId: "parent-session",
        sequence: 0,
        sessionId: "remote-session",
        turnId: "turn-remote",
        type: "channel.delivery.completed",
      });
      await completeTurn(runtime.hooks, "remote-session", "turn-remote");
    });
    await runtime.provider.forceFlush();

    const spans = runtime.exporter.getFinishedSpans();
    const channelDelivery = byName(spans, "agent.channel.delivery")[0]!;
    const turn = byName(spans, "agent.turn")[0]!;
    expect(byName(spans, "agent.session")).toHaveLength(0);
    expect(channelDelivery.parentSpanContext).toMatchObject(parentTraceContext);
    expect(turn.parentSpanContext).toMatchObject(parentTraceContext);
    expect(turn.spanContext().traceId).toBe(parentTraceContext.traceId);
  });

  it("emits the agent hierarchy in one session trace", async () => {
    const runtime = createRuntime();
    const delivery = runtime.tracer.startSpan("workflow.delivery");
    const activeContext = runtimeTrace.setSpan(ROOT_CONTEXT, delivery);
    const contextActive = vi.spyOn(context, "active").mockReturnValue(activeContext);
    const contextWith = vi.spyOn(context, "with");
    await context.with(activeContext, () =>
      emitAttempt({
        channelAudience: "public",
        hooks: runtime.hooks,
        runInContext: runtime.runInContext,
        sessionId: "session-1",
        turnId: "turn-1",
        turnSequence: 0,
      }),
    );
    contextActive.mockRestore();
    delivery.end();
    const executionParents = contextWith.mock.calls.map(([parent]) => parent);
    contextWith.mockRestore();
    await runtime.provider.forceFlush();

    const spans = runtime.exporter.getFinishedSpans();
    const turn = byName(spans, "agent.turn")[0]!;
    const step = byName(spans, "agent.step")[0]!;
    const operation = byName(spans, "ai.streamText")[0]!;
    const model = byName(spans, "chat claude-test")[0]!;
    const action = byName(spans, "agent.action")[0]!;
    const tool = byName(spans, "ai.toolCall")[0]!;

    const session = byName(spans, "agent.session")[0]!;
    expect(session.parentSpanContext).toBeUndefined();
    expect(session.events.map((event) => event.name)).toEqual(["session.started"]);
    expect(session.attributes).toMatchObject({
      "agent.channel.audience": "public",
      "agent.session.id": "session-1",
      "agent.trace.schema.version": 2,
    });
    expect(turn.parentSpanContext?.spanId).toBe(session.spanContext().spanId);
    expect(step.parentSpanContext?.spanId).toBe(turn.spanContext().spanId);
    expect(operation.parentSpanContext?.spanId).toBe(step.spanContext().spanId);
    expect(step.links).toEqual([
      expect.objectContaining({
        attributes: { "eve.link.type": "workflow.delivery" },
        context: delivery.spanContext(),
      }),
    ]);
    expect(model.parentSpanContext?.spanId).toBe(operation.spanContext().spanId);
    expect(
      executionParents.some(
        (parent) =>
          apiTrace.getSpan(parent as never)?.spanContext().spanId === model.spanContext().spanId,
      ),
    ).toBe(true);
    expect(action.parentSpanContext?.spanId).toBe(step.spanContext().spanId);
    expect(tool.parentSpanContext?.spanId).toBe(action.spanContext().spanId);
    for (const span of [turn, step, operation, model, action, tool]) {
      expect(span.attributes).not.toHaveProperty("agent.channel.audience");
    }
    expect(
      new Set(
        spans
          .filter((span) => span.name !== "workflow.delivery")
          .map((span) => span.spanContext().traceId),
      ),
    ).toHaveLength(1);
    expect(turn.events.map((event) => event.name)).toEqual(["turn.started", "turn.completed"]);
    // Turn timestamps are millisecond-quantized (`Date.now`), so the end
    // comparison against the step's sub-millisecond clock gets 1ms of slack.
    expect(turn.attributes).toMatchObject({ "agent.name": "weather" });
    expect(nanos(turn.startTime)).toBeLessThanOrEqual(nanos(step.startTime));
    expect(nanos(turn.endTime)).toBeGreaterThanOrEqual(nanos(step.endTime) - 1_000_000n);
    expect(step.attributes).toMatchObject({
      "agent.framework.name": "eve",
      "agent.model.id": "claude-test",
      "agent.model.provider": "anthropic",
      "agent.usage.input_tokens": 10,
      "agent.usage.output_tokens": 5,
      "gen_ai.usage.cache_creation.input_tokens": 2,
      "gen_ai.usage.cache_read.input_tokens": 4,
    });
    expect(action.attributes).toMatchObject({
      "agent.action.kind": "tool-call",
      "agent.action.name": "weather",
      "agent.framework.name": "eve",
    });
  });

  it.each(["private", "unknown"] as const)(
    "records %s conversation traces by default",
    async (audience) => {
      const runtime = createRuntime(new InMemoryAgentTraceStateStore(), null);

      await emitAttempt({
        channelAudience: audience,
        hooks: runtime.hooks,
        runInContext: runtime.runInContext,
        sessionId: `session-${audience}`,
        turnId: `turn-${audience}`,
        turnSequence: 0,
      });
      await runtime.provider.forceFlush();

      expect(byName(runtime.exporter.getFinishedSpans(), "agent.session")).toHaveLength(1);
    },
  );

  it("preserves the parent's sampling decision for adopted traces", async () => {
    const runtime = createRuntime(new InMemoryAgentTraceStateStore(), null);

    await emitAttempt({
      channelAudience: "private",
      hooks: runtime.hooks,
      parentTraceContext: {
        spanId: "a".repeat(16),
        traceFlags: 1,
        traceId: "b".repeat(32),
      },
      runInContext: runtime.runInContext,
      sessionId: "session-private",
      turnId: "turn-private",
      turnSequence: 0,
    });
    await runtime.provider.forceFlush();

    // The parent's traceFlags are authoritative — the child does not re-evaluate.
    const spans = runtime.exporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) {
      expect(span.spanContext().traceId).toBe("b".repeat(32));
    }
  });

  it("allows private tracing when the trace policy opts in", async () => {
    const runtime = createRuntime(new InMemoryAgentTraceStateStore(), () => true);

    await emitAttempt({
      channelAudience: "private",
      hooks: runtime.hooks,
      runInContext: runtime.runInContext,
      sessionId: "session-private",
      turnId: "turn-private",
      turnSequence: 0,
    });
    await runtime.provider.forceFlush();

    expect(byName(runtime.exporter.getFinishedSpans(), "agent.session")).toHaveLength(1);
  });

  it("writes merged runtime context onto the step, operation, and chat spans", async () => {
    const runtime = createRuntime();

    await emitAttempt({
      hooks: runtime.hooks,
      runInContext: runtime.runInContext,
      runtimeContext: {
        "eve.session.id": "session-1",
        "posthog.distinct_id": "user-123",
        nested: { ignored: undefined, team: "platform" },
        tags: ["a", "b"],
      },
      sessionId: "session-1",
      turnId: "turn-1",
      turnSequence: 0,
    });
    await runtime.provider.forceFlush();

    const spans = runtime.exporter.getFinishedSpans();
    const step = byName(spans, "agent.step")[0]!;
    const operation = byName(spans, "ai.streamText")[0]!;
    const model = byName(spans, "chat claude-test")[0]!;
    for (const span of [step, operation, model]) {
      expect(span.attributes).toMatchObject({
        "ai.settings.context.eve.session.id": "session-1",
        "ai.settings.context.posthog.distinct_id": "user-123",
        "ai.settings.context.nested.team": "platform",
        "ai.settings.context.tags": ["a", "b"],
      });
    }
  });

  it("omits context attributes when no runtime context is merged", async () => {
    const runtime = createRuntime();

    await emitAttempt({
      hooks: runtime.hooks,
      runInContext: runtime.runInContext,
      sessionId: "session-1",
      turnId: "turn-1",
      turnSequence: 0,
    });
    await runtime.provider.forceFlush();

    const spans = runtime.exporter.getFinishedSpans();
    const step = byName(spans, "agent.step")[0]!;
    const operation = byName(spans, "ai.streamText")[0]!;
    const model = byName(spans, "chat claude-test")[0]!;
    for (const span of [step, operation, model]) {
      expect(
        Object.keys(span.attributes).some((key) => key.startsWith("ai.settings.context.")),
      ).toBe(false);
    }
  });

  it("keeps replayable boundary ids stable across physical redeliveries", async () => {
    const first = createRuntime();
    const redelivery = createRuntime();
    const parentTraceContext: InstrumentationTraceContext = {
      spanId: "b".repeat(16),
      traceFlags: 1,
      traceId: "a".repeat(32),
    };

    for (const runtime of [first, redelivery]) {
      await emitAttempt({
        hooks: runtime.hooks,
        parentTraceContext,
        runInContext: runtime.runInContext,
        sessionId: "session-1",
        turnId: "turn-1",
        turnSequence: 0,
      });
      await runtime.provider.forceFlush();
    }

    const firstSpans = first.exporter.getFinishedSpans();
    const redeliverySpans = redelivery.exporter.getFinishedSpans();
    for (const name of ["agent.turn", "agent.step", "agent.action", "ai.toolCall"]) {
      expect(byName(redeliverySpans, name)[0]!.spanContext().spanId).toBe(
        byName(firstSpans, name)[0]!.spanContext().spanId,
      );
    }
    for (const name of ["ai.streamText", "chat claude-test"]) {
      expect(byName(redeliverySpans, name)[0]!.spanContext().spanId).not.toBe(
        byName(firstSpans, name)[0]!.spanContext().spanId,
      );
    }
  });

  it("parents a tool to its action when SDK telemetry arrives first", async () => {
    const runtime = createRuntime();
    const scope: InstrumentationAttemptScope = {
      attemptId: "session-1:turn-1:0:0",
      attemptIndex: 0,
      sessionId: "session-1",
      stepIndex: 0,
      turnId: "turn-1",
    };
    const actionKey = actionIdempotencyKey(scope.sessionId, scope.turnId, "tool-1");
    const toolKey = `tool:${scope.attemptId}:tool-1:0`;

    await publishTurnStarted({
      hooks: runtime.hooks,
      sessionId: scope.sessionId,
      turnId: scope.turnId,
      turnSequence: 0,
    });
    await runtime.hooks.publish({
      idempotencyKey: attemptIdempotencyKey(scope),
      operation: { modelId: "model", operationId: "ai.streamText", provider: "test" },
      scope,
      type: "step.attempt.started",
    });
    await runtime.hooks.publish({
      callId: "tool-1",
      idempotencyKey: toolKey,
      input: { secret: "value" },
      scope,
      toolName: "weather",
      type: "tool.call.started",
    });
    await runtime.hooks.publish({
      idempotencyKey: toolKey,
      output: { output: "sunny", type: "result" },
      scope,
      type: "tool.call.completed",
    });
    await runtime.hooks.publish({
      callId: "tool-1",
      idempotencyKey: actionKey,
      input: { secret: "value" },
      kind: "tool-call",
      name: "weather",
      scope,
      type: "action.started",
    });
    await runtime.hooks.publish({
      idempotencyKey: actionKey,
      outcome: "completed",
      output: { output: "sunny", type: "result" },
      scope,
      type: "action.completed",
    });
    const uncorrelatedToolKey = `tool:${scope.attemptId}:tool-2:0`;
    await runtime.hooks.publish({
      callId: "tool-2",
      idempotencyKey: uncorrelatedToolKey,
      input: {},
      scope,
      toolName: "final_output",
      type: "tool.call.started",
    });
    await runtime.hooks.publish({
      idempotencyKey: uncorrelatedToolKey,
      output: { output: "done", type: "result" },
      scope,
      type: "tool.call.completed",
    });
    await runtime.hooks.publish({
      idempotencyKey: attemptIdempotencyKey(scope),
      scope,
      type: "step.attempt.completed",
    });
    await runtime.provider.forceFlush();

    const spans = runtime.exporter.getFinishedSpans();
    const action = byName(spans, "agent.action")[0]!;
    const [tool, uncorrelatedTool] = byName(spans, "ai.toolCall");
    expect(tool!.parentSpanContext?.spanId).toBe(action.spanContext().spanId);
    expect(uncorrelatedTool!.parentSpanContext?.spanId).toBe(
      byName(spans, "agent.step")[0]!.spanContext().spanId,
    );
  });

  it("reconstructs a durable action span in a replacement worker", async () => {
    const first = createRuntime(new ContextAgentTraceStateStore());
    const context = new ContextContainer();
    const scope: InstrumentationAttemptScope = {
      attemptId: "session-1:turn-1:0:0",
      attemptIndex: 0,
      sessionId: "session-1",
      stepIndex: 0,
      turnId: "turn-1",
    };
    const actionKey = actionIdempotencyKey(scope.sessionId, scope.turnId, "tool-1");
    const toolKey = `tool:${scope.attemptId}:tool-1:0`;

    await contextStorage.run(context, async () => {
      await publishTurnStarted({
        hooks: first.hooks,
        sessionId: scope.sessionId,
        turnId: scope.turnId,
        turnSequence: 0,
      });
      await first.hooks.publish({
        idempotencyKey: attemptIdempotencyKey(scope),
        operation: { modelId: "model", operationId: "ai.streamText", provider: "test" },
        scope,
        type: "step.attempt.started",
      });
      await first.hooks.publish({
        callId: "tool-1",
        idempotencyKey: actionKey,
        input: { secret: "value" },
        kind: "tool-call",
        name: "weather",
        scope,
        type: "action.started",
      });
      await first.hooks.publish({
        idempotencyKey: attemptIdempotencyKey(scope),
        scope,
        type: "step.attempt.completed",
      });
    });
    await first.provider.forceFlush();
    const firstSpans = first.exporter.getFinishedSpans();
    const step = byName(firstSpans, "agent.step")[0]!;

    await new Promise((resolve) => setTimeout(resolve, 2));
    const acceptedAtMs = Date.now() + 1_000;
    const restored = await deserializeContext(await serializeContext(context));
    const replacement = createRuntime(new ContextAgentTraceStateStore());
    const replacementScope = {
      ...scope,
      attemptId: "session-1:turn-2:0:0",
      turnId: "turn-2",
    };
    await contextStorage.run(restored, async () => {
      // Approval-resumed tools can execute before the replacement AI SDK emits
      // a new step start. The persisted action context is still their parent.
      await replacement.hooks.publish({
        callId: "tool-1",
        idempotencyKey: toolKey,
        input: {},
        scope: replacementScope,
        toolName: "weather",
        type: "tool.call.started",
      });
      await replacement.hooks.publish({
        idempotencyKey: toolKey,
        output: { output: "ok", type: "result" },
        scope: replacementScope,
        type: "tool.call.completed",
      });
      await replacement.hooks.publish({
        acceptedAtMs,
        idempotencyKey: actionKey,
        outcome: "completed",
        output: { output: { temperature: 72 }, type: "result" },
        scope,
        type: "action.completed",
      });
    });
    await replacement.provider.forceFlush();

    const replacementSpans = replacement.exporter.getFinishedSpans();
    const action = byName(replacementSpans, "agent.action")[0]!;
    const tool = byName(replacementSpans, "ai.toolCall")[0]!;
    expect(action.spanContext().spanId).toBe(tool.parentSpanContext?.spanId);
    expect(action.parentSpanContext?.spanId).toBe(step.spanContext().spanId);
    expect(action.attributes).toMatchObject({
      "agent.action.kind": "tool-call",
      "agent.action.name": "weather",
      "gen_ai.tool.call.arguments": expect.stringContaining("secret"),
      "gen_ai.tool.call.result": expect.stringContaining("temperature"),
    });
    expect(nanos(action.duration)).toBeGreaterThan(0n);
    expect(nanos(action.endTime)).toBe(BigInt(acceptedAtMs) * 1_000_000n);
  });

  it("reconstructs a durable approval span in a replacement worker", async () => {
    const first = createRuntime(new ContextAgentTraceStateStore());
    const context = new ContextContainer();
    const scope: InstrumentationAttemptScope = {
      attemptId: "session-1:turn-1:0:0",
      attemptIndex: 0,
      sessionId: "session-1",
      stepIndex: 0,
      turnId: "turn-1",
    };
    const actionKey = actionIdempotencyKey(scope.sessionId, scope.turnId, "tool-1");
    const inputKey = inputIdempotencyKey(scope.sessionId, scope.turnId, "approval-1");

    await contextStorage.run(context, async () => {
      await publishTurnStarted({
        hooks: first.hooks,
        sessionId: scope.sessionId,
        turnId: scope.turnId,
        turnSequence: 0,
      });
      await first.hooks.publish({
        callId: "tool-1",
        idempotencyKey: actionKey,
        input: { city: "SF" },
        kind: "tool-call",
        name: "weather",
        scope,
        type: "action.started",
      });
      await first.hooks.publish({
        action: { callId: "tool-1", name: "weather" },
        idempotencyKey: inputKey,
        kind: "tool-approval",
        request: { prompt: "Approve weather?" },
        requestId: "approval-1",
        scope,
        type: "input.requested",
      });
    });

    await new Promise((resolve) => setTimeout(resolve, 2));
    const restored = await deserializeContext(await serializeContext(context));
    const replacement = createRuntime(new ContextAgentTraceStateStore());
    await contextStorage.run(restored, async () => {
      await replacement.hooks.publish({
        idempotencyKey: inputKey,
        kind: "tool-approval",
        outcome: "approved",
        requestId: "approval-1",
        response: { optionId: "approve" },
        scope,
        type: "input.resolved",
      });
      await replacement.hooks.publish({
        idempotencyKey: actionKey,
        outcome: "completed",
        output: { output: { temperature: 72 }, type: "result" },
        scope,
        type: "action.completed",
      });
    });
    await replacement.provider.forceFlush();

    const spans = replacement.exporter.getFinishedSpans();
    const approval = byName(spans, "agent.approval")[0]!;
    const action = byName(spans, "agent.action")[0]!;
    expect(approval.parentSpanContext?.spanId).toBe(action.spanContext().spanId);
    expect(approval.status.code).toBe(SpanStatusCode.UNSET);
    expect(approval.attributes).toMatchObject({
      "agent.action.call_id": "tool-1",
      "agent.action.name": "weather",
      "agent.approval.kind": "tool-approval",
      "agent.approval.outcome": "approved",
      "agent.approval.request": expect.stringContaining("Approve weather?"),
      "agent.approval.request_id": "approval-1",
      "agent.approval.response": expect.stringContaining("approve"),
      "agent.session.id": "session-1",
      "agent.step.index": 0,
      "agent.turn.id": "turn-1",
    });
    expect(nanos(approval.duration)).toBeGreaterThan(0n);
  });

  it("does not create approval spans for other input requests", async () => {
    const runtime = createRuntime();
    const scope: InstrumentationAttemptScope = {
      attemptId: "session-1:turn-1:0:0",
      attemptIndex: 0,
      sessionId: "session-1",
      stepIndex: 0,
      turnId: "turn-1",
    };
    const key = inputIdempotencyKey(scope.sessionId, scope.turnId, "question-1");
    await runtime.hooks.publish({
      action: { callId: "question-1", name: "ask_question" },
      idempotencyKey: key,
      kind: "question",
      request: { prompt: "Which region?" },
      requestId: "question-1",
      scope,
      type: "input.requested",
    });
    await runtime.hooks.publish({
      idempotencyKey: key,
      kind: "question",
      outcome: "answered",
      requestId: "question-1",
      response: { text: "west" },
      scope,
      type: "input.resolved",
    });
    await runtime.provider.forceFlush();
    expect(byName(runtime.exporter.getFinishedSpans(), "agent.approval")).toHaveLength(0);
  });

  it("ends SDK spans but leaves durable actions for their own terminal", async () => {
    const runtime = createRuntime();
    await emitAttempt({
      hooks: runtime.hooks,
      runInContext: runtime.runInContext,
      sessionId: "session-1",
      skipModelTerminal: true,
      skipToolTerminal: true,
      turnId: "turn-1",
      turnSequence: 0,
    });
    await runtime.provider.forceFlush();

    const spans = runtime.exporter.getFinishedSpans();
    expect(byName(spans, "chat claude-test")).toHaveLength(1);
    expect(byName(spans, "agent.action")).toHaveLength(0);
    expect(byName(spans, "ai.toolCall")).toHaveLength(1);
    expect(byName(spans, "agent.step")).toHaveLength(1);
  });

  it("records a failed attempt on model, tool, and action spans still open", async () => {
    const runtime = createRuntime();
    const error = new Error("attempt failed");
    await emitAttempt({
      attemptError: error,
      hooks: runtime.hooks,
      runInContext: runtime.runInContext,
      sessionId: "session-1",
      skipModelTerminal: true,
      skipToolTerminal: true,
      turnId: "turn-1",
      turnSequence: 0,
    });
    await runtime.provider.forceFlush();

    const spans = runtime.exporter.getFinishedSpans();
    for (const name of ["chat claude-test", "agent.action", "ai.toolCall"]) {
      const span = byName(spans, name)[0]!;
      expect(span.status).toEqual({ code: SpanStatusCode.ERROR, message: error.message });
      expect(span.events).toContainEqual(
        expect.objectContaining({
          attributes: expect.objectContaining({ "exception.message": error.message }),
          name: "exception",
        }),
      );
    }
  });

  it("labels a subagent action by its kind, not as a plain tool", async () => {
    const runtime = createRuntime();
    await emitAttempt({
      actionUsage: {
        inputTokenDetails: { cacheReadTokens: 3, cacheWriteTokens: 4 },
        inputTokens: 10,
        outputTokens: 5,
      },
      hooks: runtime.hooks,
      actionKind: "subagent-call",
      runInContext: runtime.runInContext,
      sessionId: "session-1",
      turnId: "turn-1",
      turnSequence: 0,
    });
    await runtime.provider.forceFlush();

    const action = runtime.exporter.getFinishedSpans().find((span) => span.name === "agent.action");
    expect(action?.attributes).toMatchObject({
      "agent.action.kind": "subagent-call",
      "agent.action.name": "weather",
      "agent.action.outcome": "completed",
      "agent.usage.input_tokens": 10,
      "agent.usage.output_tokens": 5,
      "gen_ai.usage.cache_creation.input_tokens": 4,
      "gen_ai.usage.cache_read.input_tokens": 3,
    });
  });

  it("captures model and tool inputs/outputs on the operation spans", async () => {
    const runtime = createRuntime();
    await emitAttempt({
      hooks: runtime.hooks,
      runInContext: runtime.runInContext,
      sessionId: "session-1",
      turnId: "turn-1",
      turnSequence: 0,
    });
    await runtime.provider.forceFlush();

    const spans = runtime.exporter.getFinishedSpans();
    const model = byName(spans, "chat claude-test")[0]!;
    const tool = byName(spans, "ai.toolCall")[0]!;
    // Provider transport noise (signatures et al.) is stripped at capture time.
    expect(model.attributes["ai.prompt.messages"]).toBe(
      '[{"content":"real user text","role":"user"}]',
    );
    expect(model.attributes["ai.prompt.system"]).toBe(
      "You are a weather assistant (system prompt).",
    );
    expect(model.attributes["ai.response.finish_reason"]).toBe("tool-calls");
    expect(model.attributes["ai.response.reasoning"]).toBe("thinking about weather");
    expect(model.attributes["ai.response.text"]).toBe("Checking the weather.");
    expect(model.attributes).toMatchObject({
      "gen_ai.agent.name": "weather",
      "gen_ai.input.messages":
        '[{"parts":[{"content":"real user text","type":"text"}],"role":"user"}]',
      "gen_ai.operation.name": "chat",
      "gen_ai.output.messages": expect.stringContaining('"finish_reason":"tool_call"'),
      "gen_ai.response.finish_reasons": ["tool-calls"],
      "gen_ai.system_instructions":
        '[{"content":"You are a weather assistant (system prompt).","type":"text"}]',
    });
    expect(model.attributes["agent.input.messages.delta"]).toBeUndefined();
    // Provider-executed tools never reach the tool loop; their calls and
    // results are captured off the model response content.
    expect(model.attributes["ai.response.tool_calls"]).toBe(
      '[{"callId":"search-1","input":{"query":"weather today"},"toolName":"web_search"}]',
    );
    expect(model.attributes["ai.response.tool_results"]).toBe(
      '[{"callId":"search-1","input":{"query":"weather today"},"output":{"results":["sunny"]},"toolName":"web_search"}]',
    );
    expect(tool.attributes["gen_ai.tool.call.arguments"]).toBe('{"secret":"value"}');
    expect(tool.attributes["gen_ai.tool.call.result"]).toBe('{"temperature":72}');
    // Runtime action spans carry content for dispatches that have no SDK tool boundary.
    const action = byName(spans, "agent.action")[0]!;
    expect(action.attributes["gen_ai.tool.call.arguments"]).toContain("secret");
    expect(action.attributes["gen_ai.tool.call.result"]).toContain("temperature");
  });

  it("caps full model input while keeping valid message JSON", async () => {
    const runtime = createRuntime();
    const manyMessages = Array.from({ length: 200 }, (_, index) => ({
      content: `message ${index} ${"x".repeat(200)}`,
      role: index % 2 === 0 ? "user" : "assistant",
    }));
    const scope: InstrumentationAttemptScope = {
      attemptId: "session-1:turn-1:0:0",
      attemptIndex: 0,
      functionId: "weather",
      sessionId: "session-1",
      stepIndex: 0,
      turnId: "turn-1",
    };
    await runtime.hooks.publish({
      agentName: "weather",
      channelKind: "http",
      idempotencyKey: sessionIdempotencyKey("session-1"),
      rootSessionId: "session-1",
      sessionId: "session-1",
      type: "session.started",
    });
    await runtime.hooks.publish({
      idempotencyKey: turnIdempotencyKey("session-1", "turn-1"),
      rootSessionId: "session-1",
      sequence: 0,
      sessionId: "session-1",
      turnId: "turn-1",
      type: "turn.started",
    });
    const bridge = createAiSdkHookBridge(scope, runtime.hooks, runtime.runInContext);
    Reflect.apply(bridge.onStart!, bridge, [
      {
        callId: "call-1",
        messages: manyMessages,
        modelId: "claude-test",
        operationId: "ai.streamText",
        provider: "anthropic",
      },
    ]);
    await Reflect.apply(bridge.onStepStart!, bridge, [{ callId: "call-1", stepNumber: 0 }]);
    await Reflect.apply(bridge.onLanguageModelCallStart!, bridge, [
      { callId: "call-1", messages: manyMessages, modelId: "claude-test", provider: "anthropic" },
    ]);
    await bridge.executeLanguageModelCall!({ callId: "call-1", execute: async () => undefined });
    await Reflect.apply(bridge.onLanguageModelCallEnd!, bridge, [
      {
        callId: "call-1",
        content: [],
        finishReason: "stop",
        performance: { responseTimeMs: 10 },
        responseId: "response-1",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    ]);
    await runtime.provider.forceFlush();

    const model = byName(runtime.exporter.getFinishedSpans(), "chat claude-test")[0]!;
    const raw = model.attributes["ai.prompt.messages"];
    expect(typeof raw).toBe("string");
    expect((raw as string).length).toBeLessThanOrEqual(32 * 1024);
    const parsed = JSON.parse(raw as string) as Array<Record<string, unknown>>;
    expect(parsed.length).toBeGreaterThan(1);
    expect(parsed[0]).toMatchObject({
      "eve.truncated": { omittedMessages: expect.any(Number) },
    });
    expect(JSON.stringify(parsed)).toContain("message 199");
    expect(JSON.stringify(parsed)).not.toContain("message 0 ");
    expect(model.attributes["agent.input.messages.delta"]).toBeUndefined();
  });

  it("captures no content by default", async () => {
    const exporter = new InMemorySpanExporter();
    const idGenerator = new AgentSpanIdGenerator();
    const provider = new BasicTracerProvider({
      idGenerator,
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const agentOtel = createAgentOtelInstrumentation({
      frameworkVersion: "test",
      idGenerator,
      stateStore: new InMemoryAgentTraceStateStore(),
      tracer: provider.getTracer("eve.agent"),
    });
    const hooks = createInstrumentationHooks([agentOtel.hook]);
    await emitAttempt({
      hooks,
      runInContext: agentOtel.runInContext,
      sessionId: "session-1",
      turnId: "turn-1",
      turnSequence: 0,
    });
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain("secret");
    expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain("temperature");
    expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain("private");
    expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain("real user text");
    expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain("system prompt");
  });

  it("resolves execution context by attempt identity across a scope snapshot", async () => {
    const runtime = createRuntime();
    const scope: InstrumentationAttemptScope = {
      attemptId: "session-1:turn-1:0:0",
      attemptIndex: 0,
      functionId: "weather",
      sessionId: "session-1",
      stepIndex: 0,
      turnId: "turn-1",
    };
    await runtime.hooks.publish({
      agentName: "weather",
      idempotencyKey: sessionIdempotencyKey("session-1"),
      rootSessionId: "session-1",
      sessionId: "session-1",
      type: "session.started",
    });
    await runtime.hooks.publish({
      idempotencyKey: turnIdempotencyKey("session-1", "turn-1"),
      rootSessionId: "session-1",
      sequence: 0,
      sessionId: "session-1",
      turnId: "turn-1",
      type: "turn.started",
    });
    await runtime.hooks.publish({
      idempotencyKey: attemptIdempotencyKey(scope),
      operation: { modelId: "model", operationId: "ai.streamText", provider: "test" },
      scope,
      type: "step.attempt.started",
    });
    const idempotencyKey = modelCallIdempotencyKey(scope, 0);
    await runtime.hooks.publish({
      idempotencyKey,
      input: { messages: [] },
      model: { modelId: "model", provider: "test" },
      scope,
      type: "model.call.started",
    });

    const withSpy = vi.spyOn(context, "with");
    await runtime.runInContext(
      { idempotencyKey, scope: { ...scope }, type: "model.call" },
      async () => undefined,
    );

    expect(withSpy).toHaveBeenCalledOnce();
    withSpy.mockRestore();
  });

  it("writes gateway cost attributes on the step span when the gateway reports them", async () => {
    const runtime = createRuntime();
    await emitAttempt({
      hooks: runtime.hooks,
      providerMetadata: {
        gateway: {
          cost: "0.000082",
          gatewayCost: "0.000182",
          generationId: "gen_01KYR80F7ZV4RM3PJ635KMXB5V",
          inputInferenceCost: "0.000042",
          outputInferenceCost: "0.00004",
        },
      },
      runInContext: runtime.runInContext,
      sessionId: "session-1",
      turnId: "turn-1",
      turnSequence: 0,
    });
    await runtime.provider.forceFlush();

    const step = byName(runtime.exporter.getFinishedSpans(), "agent.step")[0]!;
    expect(step.attributes).toMatchObject({
      "gen_ai.generation.id": "gen_01KYR80F7ZV4RM3PJ635KMXB5V",
      "gen_ai.usage.cost": 0.000082,
      "gen_ai.usage.gateway_cost": 0.000182,
      "gen_ai.usage.input_cost": 0.000042,
      "gen_ai.usage.output_cost": 0.00004,
    });
  });

  it("emits no cost attributes when the provider is not the gateway", async () => {
    const runtime = createRuntime();
    await emitAttempt({
      hooks: runtime.hooks,
      providerMetadata: { anthropic: { cacheCreationInputTokens: 0 } },
      runInContext: runtime.runInContext,
      sessionId: "session-1",
      turnId: "turn-1",
      turnSequence: 0,
    });
    await runtime.provider.forceFlush();

    const step = byName(runtime.exporter.getFinishedSpans(), "agent.step")[0]!;
    const keys = Object.keys(step.attributes);
    for (const key of keys) {
      expect(key).not.toContain("cost");
    }
  });

  it("reuses one trace id across turns", async () => {
    const stateStore = new InMemoryAgentTraceStateStore();
    const firstRuntime = createRuntime(stateStore);
    await emitAttempt({
      hooks: firstRuntime.hooks,
      runInContext: firstRuntime.runInContext,
      sessionId: "session-1",
      turnId: "turn-1",
      turnSequence: 0,
    });
    await firstRuntime.provider.forceFlush();

    // A new provider instance models resumption in another Workflow worker.
    const secondRuntime = createRuntime(stateStore);
    await emitAttempt({
      hooks: secondRuntime.hooks,
      runInContext: secondRuntime.runInContext,
      sessionId: "session-1",
      turnId: "turn-2",
      turnSequence: 1,
    });
    await secondRuntime.provider.forceFlush();

    const turns = [
      ...byName(firstRuntime.exporter.getFinishedSpans(), "agent.turn"),
      ...byName(secondRuntime.exporter.getFinishedSpans(), "agent.turn"),
    ];
    expect(turns).toHaveLength(2);
    expect(turns[0]!.spanContext().traceId).toBe(turns[1]!.spanContext().traceId);
    const firstModel = byName(firstRuntime.exporter.getFinishedSpans(), "chat claude-test")[0]!;
    const secondModel = byName(secondRuntime.exporter.getFinishedSpans(), "chat claude-test")[0]!;
    expect(firstModel.attributes["ai.prompt.system"]).toBe(
      "You are a weather assistant (system prompt).",
    );
    expect(secondModel.attributes["ai.prompt.system"]).toBe(
      "You are a weather assistant (system prompt).",
    );
    expect(secondModel.attributes["gen_ai.system_instructions"]).toBe(
      '[{"content":"You are a weather assistant (system prompt).","type":"text"}]',
    );
    expect(secondModel.attributes["agent.input.messages.delta"]).toBeUndefined();
    expect(secondModel.attributes["ai.prompt.messages"]).toBe(
      '[{"content":"real user text","role":"user"}]',
    );
    expect([
      ...byName(firstRuntime.exporter.getFinishedSpans(), "agent.session"),
      ...byName(secondRuntime.exporter.getFinishedSpans(), "agent.session"),
    ]).toHaveLength(1);
  });

  it("restores durable turn context when a replacement worker runs the attempt", async () => {
    const stateStore = new InMemoryAgentTraceStateStore();
    const firstRuntime = createRuntime(stateStore);
    await publishTurnStarted({
      hooks: firstRuntime.hooks,
      sessionId: "session-1",
      turnId: "turn-1",
      turnSequence: 0,
    });
    await firstRuntime.provider.forceFlush();

    const replacementRuntime = createRuntime(stateStore);
    await emitAttempt({
      hooks: replacementRuntime.hooks,
      runInContext: replacementRuntime.runInContext,
      sessionId: "session-1",
      turnAlreadyStarted: true,
      turnId: "turn-1",
      turnSequence: 0,
    });
    await replacementRuntime.provider.forceFlush();

    // The replacement's session transition emits the turn span with the span
    // id the first worker allocated, so descendants from both workers attach.
    expect(byName(firstRuntime.exporter.getFinishedSpans(), "agent.turn")).toHaveLength(0);
    const replacementSpans = replacementRuntime.exporter.getFinishedSpans();
    const turn = byName(replacementSpans, "agent.turn")[0]!;
    const step = byName(replacementSpans, "agent.step")[0]!;
    const action = byName(replacementSpans, "agent.action")[0]!;

    expect(step.parentSpanContext?.spanId).toBe(turn.spanContext().spanId);
    expect(action.parentSpanContext?.spanId).toBe(step.spanContext().spanId);
    expect(step.spanContext().traceId).toBe(turn.spanContext().traceId);
  });

  it("opens a fresh trace when a durable attempt replays before its state checkpoints", async () => {
    const firstRuntime = createRuntime();
    const replayRuntime = createRuntime();
    await emitAttempt({
      hooks: firstRuntime.hooks,
      runInContext: firstRuntime.runInContext,
      sessionId: "session-1",
      turnId: "turn-1",
      turnSequence: 0,
    });
    await emitAttempt({
      hooks: replayRuntime.hooks,
      runInContext: replayRuntime.runInContext,
      sessionId: "session-1",
      turnId: "turn-1",
      turnSequence: 0,
    });

    const firstTurn = byName(firstRuntime.exporter.getFinishedSpans(), "agent.turn")[0]!;
    const replayTurn = byName(replayRuntime.exporter.getFinishedSpans(), "agent.turn")[0]!;
    // The abandoned attempt keeps its own trace rather than interleaving with
    // the retry. Both carry `agent.session.id`, so the session view still
    // resolves to every trace the session produced.
    expect(replayTurn.spanContext().traceId).not.toBe(firstTurn.spanContext().traceId);
    expect(replayTurn.attributes["agent.session.id"]).toBe(
      firstTurn.attributes["agent.session.id"],
    );
  });

  it("keeps a long session on one persisted trace", async () => {
    const runtime = createRuntime();
    const turnCount = 201;
    for (let sequence = 0; sequence < turnCount; sequence += 1) {
      await publishTurnStarted({
        hooks: runtime.hooks,
        sessionId: "session-1",
        turnId: `turn-${sequence}`,
        turnSequence: sequence,
      });
      await completeTurn(runtime.hooks, "session-1", `turn-${sequence}`);
    }
    await runtime.provider.forceFlush();

    const spans = runtime.exporter.getFinishedSpans();
    const sessions = byName(spans, "agent.session");
    const turns = byName(spans, "agent.turn");

    expect(sessions).toHaveLength(1);
    expect(turns).toHaveLength(turnCount);
    expect(
      turns.every((turn) => turn.spanContext().traceId === sessions[0]!.spanContext().traceId),
    ).toBe(true);
  });

  it("records a subagent child into its parent's trace", async () => {
    const runtime = createRuntime();
    await publishTurnStarted({
      hooks: runtime.hooks,
      sessionId: "session-1",
      turnId: "turn-1",
      turnSequence: 0,
    });
    await runtime.provider.forceFlush();
    const parentSession = byName(runtime.exporter.getFinishedSpans(), "agent.session")[0]!;

    await publishTurnStarted({
      hooks: runtime.hooks,
      parentLineage: {
        callId: "call-1",
        sessionId: "session-1",
        subagentName: "researcher",
        turnId: "turn-1",
      },
      parentTraceContext: parentSession.spanContext(),
      rootSessionId: "session-1",
      sessionId: "child-1",
      turnId: "child-turn-1",
      turnSequence: 0,
    });
    await completeTurn(runtime.hooks, "child-1", "child-turn-1");
    await runtime.provider.forceFlush();

    const spans = runtime.exporter.getFinishedSpans();
    const childTurn = byName(spans, "agent.turn").find(
      (span) => span.attributes["agent.session.id"] === "child-1",
    )!;

    expect(childTurn.spanContext().traceId).toBe(parentSession.spanContext().traceId);
    expect(childTurn.parentSpanContext?.spanId).toBe(parentSession.spanContext().spanId);
    expect(childTurn.attributes["agent.subagent.name"]).toBe("researcher");
    expect(childTurn.attributes).not.toHaveProperty("agent.parent.call_id");
    expect(childTurn.attributes).not.toHaveProperty("agent.parent.session.id");
    expect(childTurn.attributes).not.toHaveProperty("agent.parent.turn.id");
    expect(byName(spans, "agent.session")).toHaveLength(1);
  });

  it("preserves a remote action as the parent of a remote child turn", async () => {
    const runtime = createRuntime();
    const parentTraceContext: InstrumentationTraceContext & { readonly isRemote: true } = {
      isRemote: true,
      spanId: "2".repeat(16),
      traceFlags: 1,
      traceId: "1".repeat(32),
    };
    await publishTurnStarted({
      hooks: runtime.hooks,
      parentTraceContext,
      rootSessionId: "parent-session",
      sessionId: "remote-child",
      turnId: "child-turn-1",
      turnSequence: 0,
    });
    await completeTurn(runtime.hooks, "remote-child", "child-turn-1");
    await runtime.provider.forceFlush();

    const childTurn = byName(runtime.exporter.getFinishedSpans(), "agent.turn")[0]!;
    expect(childTurn.spanContext().traceId).toBe(parentTraceContext.traceId);
    expect(childTurn.parentSpanContext).toMatchObject(parentTraceContext);
  });

  it("opens its own root when a child session is handed no parent trace", async () => {
    const runtime = createRuntime();
    await publishTurnStarted({
      hooks: runtime.hooks,
      rootSessionId: "session-1",
      sessionId: "child-1",
      turnId: "child-turn-1",
      turnSequence: 0,
    });
    await runtime.provider.forceFlush();

    const sessions = byName(runtime.exporter.getFinishedSpans(), "agent.session");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.attributes["agent.session.id"]).toBe("child-1");
    expect(sessions[0]!.parentSpanContext).toBeUndefined();
  });

  it("keeps a long subagent child in its adopted trace", async () => {
    const runtime = createRuntime();
    await publishTurnStarted({
      hooks: runtime.hooks,
      sessionId: "session-1",
      turnId: "turn-1",
      turnSequence: 0,
    });
    await runtime.provider.forceFlush();
    const parentSession = byName(runtime.exporter.getFinishedSpans(), "agent.session")[0]!;

    for (let sequence = 0; sequence < 201; sequence += 1) {
      await publishTurnStarted({
        hooks: runtime.hooks,
        parentTraceContext: parentSession.spanContext(),
        rootSessionId: "session-1",
        sessionId: "child-1",
        turnId: `child-turn-${sequence}`,
        turnSequence: sequence,
      });
      await completeTurn(runtime.hooks, "child-1", `child-turn-${sequence}`);
    }
    await runtime.provider.forceFlush();

    const spans = runtime.exporter.getFinishedSpans();
    expect(byName(spans, "agent.session")).toHaveLength(1);
    expect(byName(spans, "agent.turn")).toHaveLength(201);
    expect(
      byName(spans, "agent.turn").every(
        (turn) => turn.spanContext().traceId === parentSession.spanContext().traceId,
      ),
    ).toBe(true);
  });

  it("marks a failed action without failing its turn", async () => {
    const runtime = createRuntime();
    await emitAttempt({
      hooks: runtime.hooks,
      runInContext: runtime.runInContext,
      sessionId: "session-1",
      toolError: new Error("tool failed"),
      turnId: "turn-1",
      turnSequence: 0,
    });
    await runtime.provider.forceFlush();

    const spans = runtime.exporter.getFinishedSpans();
    const action = byName(spans, "agent.action")[0]!;
    expect(action.status.code).toBe(SpanStatusCode.ERROR);
    expect(action.attributes).toMatchObject({
      "agent.action.error.code": "TOOL_CALL_FAILED",
      "agent.action.outcome": "failed",
      "error.type": "TOOL_CALL_FAILED",
    });
    expect(byName(spans, "agent.turn")[0]!.status.code).toBe(SpanStatusCode.UNSET);
  });
});

describe("AgentSpanIdGenerator.withTraceId", () => {
  it("primes the next generateTraceId call", () => {
    const gen = new AgentSpanIdGenerator();
    const primed = "e".repeat(32);
    const result = gen.withTraceId(primed, () => gen.generateTraceId());
    expect(result).toBe(primed);
    // After the callback, a fresh call should produce a different id.
    const next = gen.generateTraceId();
    expect(next).not.toBe(primed);
  });

  it("nests inside withSpanId to prime both ids", () => {
    const gen = new AgentSpanIdGenerator();
    const primedTraceId = "f".repeat(32);
    const primedSpanId = "a".repeat(16);
    let capturedTraceId: string | undefined;
    let capturedSpanId: string | undefined;
    gen.withSpanId(primedSpanId, () =>
      gen.withTraceId(primedTraceId, () => {
        capturedTraceId = gen.generateTraceId();
        capturedSpanId = gen.generateSpanId();
      }),
    );
    expect(capturedTraceId).toBe(primedTraceId);
    expect(capturedSpanId).toBe(primedSpanId);
  });
});
