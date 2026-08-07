import { SpanStatusCode } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";

import { createAiSdkHookBridge } from "#harness/ai-sdk-hook-bridge.js";
import {
  createAgentOtelInstrumentation,
  SESSION_WINDOW_TURN_LIMIT,
} from "#tracing/agent-otel-provider.js";
import { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";
import { InMemoryAgentTraceStateStore } from "#tracing/agent-trace-state.js";
import {
  createInstrumentationHooks,
  type InstrumentationAttemptScope,
  type InstrumentationContextRunner,
  type InstrumentationHooks,
  type InstrumentationParentLineage,
  type InstrumentationTraceContext,
} from "#harness/instrumentation-lifecycle.js";

interface TestRuntime {
  readonly exporter: InMemorySpanExporter;
  readonly hooks: InstrumentationHooks;
  readonly provider: BasicTracerProvider;
  readonly runInContext: InstrumentationContextRunner;
}

function createRuntime(stateStore = new InMemoryAgentTraceStateStore()): TestRuntime {
  const exporter = new InMemorySpanExporter();
  const idGenerator = new AgentSpanIdGenerator();
  const provider = new BasicTracerProvider({
    idGenerator,
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const agentOtel = createAgentOtelInstrumentation({
    frameworkVersion: "test",
    idGenerator,
    stateStore,
    tracer: provider.getTracer("eve.agent"),
  });
  const hooks = createInstrumentationHooks([agentOtel.hook]);
  return { exporter, hooks, provider, runInContext: agentOtel.runInContext };
}

async function emitAttempt(input: {
  readonly attemptIndex?: number;
  readonly hooks: InstrumentationHooks;
  readonly runInContext: InstrumentationContextRunner;
  readonly providerMetadata?: Readonly<Record<string, unknown>>;
  readonly sessionId: string;
  readonly toolError?: Error;
  readonly turnAlreadyStarted?: boolean;
  readonly turnId: string;
  readonly turnSequence: number;
}): Promise<void> {
  const scope: InstrumentationAttemptScope = {
    attemptId: `${input.sessionId}:${input.turnId}:0:${input.attemptIndex ?? 0}`,
    attemptIndex: input.attemptIndex ?? 0,
    functionId: "weather",
    sessionId: input.sessionId,
    stepIndex: 0,
    turnId: input.turnId,
  };
  if (input.turnAlreadyStarted !== true) {
    await publishTurnStarted(input);
  }

  const bridge = createAiSdkHookBridge(scope, input.hooks, input.runInContext);
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

  if (input.providerMetadata !== undefined) {
    await input.hooks.publish({
      providerMetadata: input.providerMetadata,
      scope,
      type: "attempt.metadata",
    });
  }

  await input.hooks.publish({ scope, type: "attempt.completed" });
  await input.hooks.publish({
    sessionId: input.sessionId,
    turnId: input.turnId,
    type: "turn.completed",
  });
  await input.hooks.publish({
    sessionId: input.sessionId,
    turnId: input.turnId,
    type: "session.waiting",
  });
}

async function publishTurnStarted(input: {
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
    channelKind: "http",
    parentTraceContext: input.parentTraceContext,
    rootSessionId,
    sessionId: input.sessionId,
    type: "session.started",
  });
  await input.hooks.publish({
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
  await hooks.publish({ sessionId, turnId, type: "turn.completed" });
  await hooks.publish({ sessionId, turnId, type: "session.waiting" });
}

function byName(spans: readonly ReadableSpan[], name: string): ReadableSpan[] {
  return spans.filter((span) => span.name === name);
}

function nanos(hrTime: readonly [number, number]): bigint {
  return BigInt(hrTime[0]) * 1_000_000_000n + BigInt(hrTime[1]);
}

describe("createAgentOtelInstrumentation", () => {
  it("emits the agent hierarchy in one session trace", async () => {
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
    const turn = byName(spans, "agent.turn")[0]!;
    const step = byName(spans, "agent.step")[0]!;
    const operation = byName(spans, "ai.streamText")[0]!;
    const model = byName(spans, "ai.streamText.doStream")[0]!;
    const action = byName(spans, "agent.action")[0]!;
    const tool = byName(spans, "ai.toolCall")[0]!;

    const session = byName(spans, "agent.session")[0]!;
    expect(session.parentSpanContext).toBeUndefined();
    expect(session.events.map((event) => event.name)).toEqual(["session.started"]);
    expect(session.attributes).toMatchObject({
      "agent.session.id": "session-1",
      "agent.session.window": 0,
    });
    expect(turn.parentSpanContext?.spanId).toBe(session.spanContext().spanId);
    expect(step.parentSpanContext?.spanId).toBe(turn.spanContext().spanId);
    expect(operation.parentSpanContext?.spanId).toBe(step.spanContext().spanId);
    expect(model.parentSpanContext?.spanId).toBe(operation.spanContext().spanId);
    expect(action.parentSpanContext?.spanId).toBe(step.spanContext().spanId);
    expect(tool.parentSpanContext?.spanId).toBe(action.spanContext().spanId);
    expect(new Set(spans.map((span) => span.spanContext().traceId))).toHaveLength(1);
    expect(turn.events.map((event) => event.name)).toEqual([
      "turn.started",
      "turn.completed",
      "session.waiting",
    ]);
    // The turn span carries the turn's real extent: it is emitted at the
    // session transition with the start time recorded at `turn.started`.
    // Turn timestamps are millisecond-quantized (`Date.now`), so the end
    // comparison against the step's sub-millisecond clock gets 1ms of slack.
    expect(turn.attributes).toMatchObject({ "agent.name": "weather", "agent.session.window": 0 });
    expect(nanos(turn.startTime)).toBeLessThanOrEqual(nanos(step.startTime));
    expect(nanos(turn.endTime)).toBeGreaterThanOrEqual(nanos(step.endTime) - 1_000_000n);
    expect(step.attributes).toMatchObject({
      "agent.framework.name": "eve",
      "agent.model.id": "claude-test",
      "agent.model.provider": "anthropic",
      "agent.root.session.id": "session-1",
      "agent.usage.input_tokens": 10,
      "agent.usage.output_tokens": 5,
      "gen_ai.usage.cache_creation.input_tokens": 2,
      "gen_ai.usage.cache_read.input_tokens": 4,
    });
    expect(action.attributes).toMatchObject({
      "agent.action.kind": "tool",
      "agent.action.name": "weather",
      "agent.framework.name": "eve",
      "agent.root.session.id": "session-1",
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
    const model = byName(spans, "ai.streamText.doStream")[0]!;
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
    // Provider-executed tools never reach the tool loop; their calls and
    // results are captured off the model response content.
    expect(model.attributes["ai.response.tool_calls"]).toBe(
      '[{"input":{"query":"weather today"},"toolName":"web_search"}]',
    );
    expect(model.attributes["ai.response.tool_results"]).toBe(
      '[{"input":{"query":"weather today"},"output":{"results":["sunny"]},"toolName":"web_search"}]',
    );
    expect(tool.attributes["gen_ai.tool.call.arguments"]).toBe('{"secret":"value"}');
    expect(tool.attributes["gen_ai.tool.call.result"]).toBe('{"temperature":72}');
    // Structural spans stay structural: content lives only on the operation spans.
    const structural = byName(spans, "agent.action")[0]!;
    expect(JSON.stringify(structural.attributes)).not.toContain("secret");
    expect(JSON.stringify(structural.attributes)).not.toContain("temperature");
  });

  it("truncates long conversations from the front, keeping valid JSON and recent messages", async () => {
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
      rootSessionId: "session-1",
      sessionId: "session-1",
      type: "session.started",
    });
    await runtime.hooks.publish({
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

    const model = byName(runtime.exporter.getFinishedSpans(), "ai.streamText.doStream")[0]!;
    const raw = model.attributes["ai.prompt.messages"];
    expect(typeof raw).toBe("string");
    expect((raw as string).length).toBeLessThanOrEqual(32 * 1024);
    const parsed = JSON.parse(raw as string) as Array<Record<string, unknown>>;
    const marker = parsed[0]!["eve.truncated"] as { omittedMessages: number };
    expect(marker.omittedMessages).toBeGreaterThan(0);
    expect(marker.omittedMessages).toBeLessThan(200);
    expect(JSON.stringify(parsed)).toContain("message 199");
    expect(JSON.stringify(parsed)).not.toContain("message 0 ");
  });

  it("captures nothing when content capture is off", async () => {
    const exporter = new InMemorySpanExporter();
    const idGenerator = new AgentSpanIdGenerator();
    const provider = new BasicTracerProvider({
      idGenerator,
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const agentOtel = createAgentOtelInstrumentation({
      captureContent: false,
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
    expect(turns.every((turn) => turn.attributes["agent.session.window"] === 0)).toBe(true);
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

    // The worker that started the turn emitted no turn span — the
    // replacement's session transition emits it with the span id the first
    // worker allocated, so descendants from both workers stay attached.
    expect(byName(firstRuntime.exporter.getFinishedSpans(), "agent.turn")).toHaveLength(0);
    const replacementSpans = replacementRuntime.exporter.getFinishedSpans();
    const turn = byName(replacementSpans, "agent.turn")[0]!;
    const step = byName(replacementSpans, "agent.step")[0]!;
    const action = byName(replacementSpans, "agent.action")[0]!;

    expect(step.parentSpanContext?.spanId).toBe(turn.spanContext().spanId);
    expect(action.parentSpanContext?.spanId).toBe(step.spanContext().spanId);
    expect(step.spanContext().traceId).toBe(turn.spanContext().traceId);
  });

  it("opens a fresh window when a durable attempt replays before its state checkpoints", async () => {
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

  it("rolls to a new window trace once a session outgrows the turn limit", async () => {
    const runtime = createRuntime();
    for (let sequence = 0; sequence <= SESSION_WINDOW_TURN_LIMIT; sequence += 1) {
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

    expect(sessions.map((span) => span.attributes["agent.session.window"])).toEqual([0, 1]);
    expect(sessions[1]!.parentSpanContext).toBeUndefined();
    expect(sessions[1]!.events.map((event) => event.name)).toEqual(["session.window.opened"]);
    expect(sessions[1]!.attributes["agent.session.window.previous.trace.id"]).toBe(
      sessions[0]!.spanContext().traceId,
    );
    expect(sessions[0]!.spanContext().traceId).not.toBe(sessions[1]!.spanContext().traceId);

    // The limit counts turns per window, so the roll lands on the turn after it.
    expect(turns).toHaveLength(SESSION_WINDOW_TURN_LIMIT + 1);
    const rolled = turns.at(-1)!;
    expect(rolled.attributes["agent.session.window"]).toBe(1);
    expect(rolled.spanContext().traceId).toBe(sessions[1]!.spanContext().traceId);
    expect(turns[0]!.spanContext().traceId).toBe(sessions[0]!.spanContext().traceId);
  });

  it("records a subagent child into the window its parent had open", async () => {
    const runtime = createRuntime();
    await publishTurnStarted({
      hooks: runtime.hooks,
      sessionId: "session-1",
      turnId: "turn-1",
      turnSequence: 0,
    });
    await runtime.provider.forceFlush();
    const parentWindow = byName(runtime.exporter.getFinishedSpans(), "agent.session")[0]!;

    await publishTurnStarted({
      hooks: runtime.hooks,
      parentTraceContext: parentWindow.spanContext(),
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

    expect(childTurn.spanContext().traceId).toBe(parentWindow.spanContext().traceId);
    expect(childTurn.parentSpanContext?.spanId).toBe(parentWindow.spanContext().spanId);
    expect(childTurn.attributes["agent.root.session.id"]).toBe("session-1");
    // The child adopts a window rather than opening one, so the trace still
    // holds exactly the root's window span.
    expect(byName(spans, "agent.session")).toHaveLength(1);
  });

  it("attributes a child turn to the exact call that dispatched it", async () => {
    const runtime = createRuntime();
    await publishTurnStarted({
      hooks: runtime.hooks,
      parentLineage: {
        callId: "call-7",
        sessionId: "session-1",
        subagentName: "researcher",
        turnId: "turn-1",
      },
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
    expect(childTurn.attributes["agent.parent.call_id"]).toBe("call-7");
    expect(childTurn.attributes["agent.parent.session.id"]).toBe("session-1");
    expect(childTurn.attributes["agent.parent.turn.id"]).toBe("turn-1");
    expect(childTurn.attributes["agent.subagent.name"]).toBe("researcher");
  });

  it("omits the subagent name when the dispatch did not carry one", async () => {
    const runtime = createRuntime();
    await publishTurnStarted({
      hooks: runtime.hooks,
      parentLineage: { callId: "call-7", sessionId: "session-1", turnId: "turn-1" },
      rootSessionId: "session-1",
      sessionId: "child-1",
      turnId: "child-turn-1",
      turnSequence: 0,
    });
    await completeTurn(runtime.hooks, "child-1", "child-turn-1");
    await runtime.provider.forceFlush();

    const childTurn = byName(runtime.exporter.getFinishedSpans(), "agent.turn").find(
      (span) => span.attributes["agent.session.id"] === "child-1",
    )!;
    expect(childTurn.attributes).not.toHaveProperty("agent.subagent.name");
    expect(childTurn.attributes["agent.parent.call_id"]).toBe("call-7");
  });

  it("leaves a top-level turn free of parent lineage attributes", async () => {
    const runtime = createRuntime();
    await publishTurnStarted({
      hooks: runtime.hooks,
      sessionId: "session-1",
      turnId: "turn-1",
      turnSequence: 0,
    });
    await completeTurn(runtime.hooks, "session-1", "turn-1");
    await runtime.provider.forceFlush();

    const turn = byName(runtime.exporter.getFinishedSpans(), "agent.turn")[0]!;
    expect(turn.attributes).not.toHaveProperty("agent.parent.call_id");
    expect(turn.attributes).not.toHaveProperty("agent.parent.session.id");
    expect(turn.attributes).not.toHaveProperty("agent.parent.turn.id");
    expect(turn.attributes).not.toHaveProperty("agent.subagent.name");
  });

  it("opens its own root when a child session is handed no parent window", async () => {
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

  it("rolls a long subagent child out of the window it adopted", async () => {
    const runtime = createRuntime();
    await publishTurnStarted({
      hooks: runtime.hooks,
      sessionId: "session-1",
      turnId: "turn-1",
      turnSequence: 0,
    });
    await runtime.provider.forceFlush();
    const parentWindow = byName(runtime.exporter.getFinishedSpans(), "agent.session")[0]!;

    for (let sequence = 0; sequence <= SESSION_WINDOW_TURN_LIMIT; sequence += 1) {
      await publishTurnStarted({
        hooks: runtime.hooks,
        parentTraceContext: parentWindow.spanContext(),
        rootSessionId: "session-1",
        sessionId: "child-1",
        turnId: `child-turn-${sequence}`,
        turnSequence: sequence,
      });
    }
    await runtime.provider.forceFlush();

    const rolled = byName(runtime.exporter.getFinishedSpans(), "agent.session").find(
      (span) => span.attributes["agent.session.id"] === "child-1",
    )!;
    expect(rolled.attributes["agent.session.window"]).toBe(1);
    expect(rolled.attributes["agent.session.window.previous.trace.id"]).toBe(
      parentWindow.spanContext().traceId,
    );
    expect(rolled.spanContext().traceId).not.toBe(parentWindow.spanContext().traceId);
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
    expect(byName(spans, "agent.action")[0]!.status.code).toBe(SpanStatusCode.ERROR);
    expect(byName(spans, "agent.turn")[0]!.status.code).toBe(SpanStatusCode.UNSET);
  });
});
