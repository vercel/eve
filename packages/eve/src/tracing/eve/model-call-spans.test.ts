import { commitOf } from "#harness/session-machine/commit.js";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";

import { AgentSpanIdGenerator, otelTelemetry } from "#compiled/@vercel/agent-runs/index.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { eventsOf } from "#harness/publication.js";
import { cascade } from "#harness/session-machine/cascade.js";
import {
  currentView,
  enterSessionProjectionAt,
  nextLinePosition,
  recordPublishedLine,
} from "#harness/session-machine/current.js";
import {
  attemptIdempotencyKey,
  createInstrumentationHooks,
  modelCallIdempotencyKey,
  type InstrumentationEventHandler,
  type InstrumentationModelCallStartedEvent,
} from "#instrumentation/lifecycle.js";
import { instrumentationScope } from "#instrumentation/scope.js";
import { createInstrumentationHandleEvent } from "#instrumentation/native-events.js";
import { InMemoryAgentTraceStateStore } from "#internal/testing/in-memory-agent-trace-state-store.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { createAgentOtelInstrumentation } from "#tracing/eve/agent-otel-provider.js";
import { eveOutputMapping } from "#tracing/eve/profile.js";

const at = "2026-10-09T00:00:00.000Z";
const turn = { turnId: "turn_0" };
const run = { runId: "run_0", turnId: "turn_0" };

const opening = [
  { data: {}, type: "session.started" },
  {
    data: { cause: { hook: "h" }, follows: null, turnId: "turn_0" },
    scope: turn,
    type: "turn.started",
  },
  { data: { owner: turn, runId: "run_0" }, scope: run, type: "model.requested" },
  { data: { attempt: 0, modelId: "m", runId: "run_0" }, scope: run, type: "model.started" },
] as SessionEvent[];

/** eve's OTel provider, with its `model.call.started` handler held until `release`. */
function slowModelCallStart(handlerTimeoutMs: number) {
  const exporter = new InMemorySpanExporter();
  const idGenerator = new AgentSpanIdGenerator();
  const provider = new BasicTracerProvider({
    idGenerator,
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const otel = createAgentOtelInstrumentation({
    environment: "production",
    frameworkVersion: "test",
    idGenerator,
    recordInputs: true,
    recordOutputs: true,
    stateStore: new InMemoryAgentTraceStateStore(),
    telemetry: otelTelemetry({
      idGenerator,
      mapping: eveOutputMapping(),
      provider,
      samplesTrace: () => true,
      tracerName: "eve.agent",
    }),
    tracePolicy: () => ({ emit: true, recordInputs: true, recordOutputs: true }),
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: Promise<void>;
  const events = otel.hook.events!;
  const onStarted = events[
    "model.call.started"
  ] as InstrumentationEventHandler<InstrumentationModelCallStartedEvent>;
  const hooks = createInstrumentationHooks(
    [
      {
        ...otel.hook,
        events: {
          ...events,
          "model.call.started": (event, ctx) => (started = held.then(() => onStarted(event, ctx))),
        },
      },
    ],
    { handlerTimeoutMs },
  ).forTrace!({
    agentName: "weather",
    audience: "public",
    channel: { kind: "http" },
    environment: "production",
    principalType: "anonymous",
  });
  const ctx = new ContextContainer();
  enterSessionProjectionAt(ctx, undefined);
  const handle = createInstrumentationHandleEvent({
    agentName: "weather",
    channelAudience: "public",
    channelKind: "http",
    environment: "production",
    functionId: "weather",
    handleEvent: async (publication) => {
      const facts = cascade(currentView(ctx), eventsOf(publication));
      recordPublishedLine(ctx, { at, facts }, nextLinePosition(ctx), facts);
    },
    hooks,
    relayed: false,
    sessionId: "s",
  })!;
  return {
    commit: (...facts: SessionEvent[]) => contextStorage.run(ctx, () => handle(commitOf(facts))),
    publish: (event: Parameters<typeof hooks.publish>[0]) =>
      contextStorage.run(ctx, () => hooks.publish(event)),
    release: async () => {
      release();
      await started;
    },
    async spans() {
      await provider.forceFlush();
      return exporter.getFinishedSpans();
    },
  };
}

describe("a model call's span", () => {
  // https://github.com/vercel/eve/issues/6174
  it.fails("records its output when its start handler outlives the handler timeout", async () => {
    const trace = slowModelCallStart(5);
    await trace.commit(...opening);
    const scope = instrumentationScope(
      {
        attempt: 0,
        channelAudience: "public",
        functionId: "weather",
        runId: "run_0",
        sessionId: "s",
        turnId: "turn_0",
      },
      0,
    );
    await trace.publish({
      idempotencyKey: attemptIdempotencyKey(scope),
      operation: { modelId: "m", operationId: "ai.streamText", provider: "test" },
      scope,
      type: "model.started",
    });
    const idempotencyKey = modelCallIdempotencyKey(scope, 0, 0);

    // The start handler times out but still opens the span once it finishes.
    await trace.publish({
      idempotencyKey,
      input: { messages: [{ content: "Weather in Oslo?", role: "user" }] },
      model: { modelId: "m", provider: "test" },
      scope,
      type: "model.call.started",
    });
    await trace.release();

    await trace.publish({
      content: [{ text: "It is 4°C in Oslo.", type: "text" }],
      finishReason: "stop",
      idempotencyKey,
      outcome: "completed",
      scope,
      type: "model.call.settled",
      usage: { inputTokens: 5, outputTokens: 7 },
    });
    await trace.commit(
      { data: { outcome: "completed", runId: "run_0" }, scope: run, type: "model.settled" },
      { data: { outcome: "completed", turnId: "turn_0" }, scope: turn, type: "turn.settled" },
    );

    const chat = (await trace.spans()).find((span) => span.name.startsWith("chat"));
    expect(chat).toBeDefined();
    expect(chat!.attributes["gen_ai.response.finish_reasons"]).toEqual(["stop"]);
    expect(chat!.attributes["gen_ai.output.messages"]).toBeDefined();
  });
});
