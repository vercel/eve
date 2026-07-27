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
  createAgentOtelProvider,
  InMemoryAgentTraceStateStore,
} from "#harness/agent-otel-provider.js";
import {
  createInstrumentationHooks,
  type InstrumentationAttemptScope,
  type InstrumentationHooks,
} from "#harness/instrumentation-lifecycle.js";

interface TestRuntime {
  readonly exporter: InMemorySpanExporter;
  readonly hooks: InstrumentationHooks;
  readonly provider: BasicTracerProvider;
}

function createRuntime(stateStore = new InMemoryAgentTraceStateStore()): TestRuntime {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const hooks = createInstrumentationHooks([
    createAgentOtelProvider({
      frameworkVersion: "test",
      stateStore,
      tracer: provider.getTracer("eve.agent"),
    }),
  ]);
  return { exporter, hooks, provider };
}

async function emitAttempt(input: {
  readonly attemptIndex?: number;
  readonly hooks: InstrumentationHooks;
  readonly sessionId: string;
  readonly toolError?: Error;
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
  await input.hooks.publish({
    agentName: "weather",
    channelKind: "http",
    rootSessionId: input.sessionId,
    sessionId: input.sessionId,
    type: "session.started",
  });
  await input.hooks.publish({
    rootSessionId: input.sessionId,
    sequence: input.turnSequence,
    sessionId: input.sessionId,
    turnId: input.turnId,
    type: "turn.started",
  });

  const bridge = createAiSdkHookBridge(scope, input.hooks);
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
    { callId: "call-1", messages: [], modelId: "claude-test", provider: "anthropic" },
  ]);
  await Reflect.apply(bridge.onLanguageModelCallEnd!, bridge, [
    {
      callId: "call-1",
      content: [],
      finishReason: "tool-calls",
      performance: { responseTimeMs: 10 },
      responseId: "response-1",
      usage: { inputTokens: 10, outputTokens: 5 },
    },
  ]);
  await Reflect.apply(bridge.onToolExecutionStart!, bridge, [
    {
      callId: "call-1",
      toolCall: { input: { secret: "value" }, toolCallId: "tool-1", toolName: "weather" },
    },
  ]);
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

function byName(spans: readonly ReadableSpan[], name: string): ReadableSpan[] {
  return spans.filter((span) => span.name === name);
}

describe("createAgentOtelProvider", () => {
  it("emits the agent hierarchy in one session trace", async () => {
    const runtime = createRuntime();
    await emitAttempt({
      hooks: runtime.hooks,
      sessionId: "session-1",
      turnId: "turn-1",
      turnSequence: 0,
    });
    await runtime.provider.forceFlush();

    const spans = runtime.exporter.getFinishedSpans();
    const session = byName(spans, "agent.session")[0]!;
    const turn = byName(spans, "agent.turn")[0]!;
    const turnTerminal = byName(spans, "agent.turn.terminal")[0]!;
    const step = byName(spans, "agent.step")[0]!;
    const action = byName(spans, "agent.action")[0]!;

    expect(session.parentSpanContext).toBeUndefined();
    expect(turn.parentSpanContext?.spanId).toBe(session.spanContext().spanId);
    expect(turnTerminal.parentSpanContext?.spanId).toBe(turn.spanContext().spanId);
    expect(step.parentSpanContext?.spanId).toBe(turn.spanContext().spanId);
    expect(action.parentSpanContext?.spanId).toBe(step.spanContext().spanId);
    expect(new Set(spans.map((span) => span.spanContext().traceId))).toHaveLength(1);
    expect(turn.events.map((event) => event.name)).toEqual(["turn.started", "session.started"]);
    expect(turnTerminal.events.map((event) => event.name)).toEqual([
      "turn.completed",
      "session.waiting",
    ]);
    expect(step.attributes).toMatchObject({
      "agent.framework.name": "eve",
      "agent.model.id": "claude-test",
      "agent.model.provider": "anthropic",
      "agent.root.session.id": "session-1",
      "agent.usage.input_tokens": 10,
      "agent.usage.output_tokens": 5,
    });
    expect(action.attributes).toMatchObject({
      "agent.action.kind": "tool",
      "agent.action.name": "weather",
      "agent.framework.name": "eve",
      "agent.root.session.id": "session-1",
    });
    expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain("private");
  });

  it("reuses one trace id across turns", async () => {
    const stateStore = new InMemoryAgentTraceStateStore();
    const firstRuntime = createRuntime(stateStore);
    await emitAttempt({
      hooks: firstRuntime.hooks,
      sessionId: "session-1",
      turnId: "turn-1",
      turnSequence: 0,
    });
    await firstRuntime.provider.forceFlush();

    // A new provider instance models resumption in another Workflow worker.
    const secondRuntime = createRuntime(stateStore);
    await emitAttempt({
      hooks: secondRuntime.hooks,
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
    expect(
      turns.flatMap((turn) => turn.events).filter((event) => event.name === "session.started"),
    ).toHaveLength(1);
  });

  it("marks a failed action without failing its turn", async () => {
    const runtime = createRuntime();
    await emitAttempt({
      hooks: runtime.hooks,
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
