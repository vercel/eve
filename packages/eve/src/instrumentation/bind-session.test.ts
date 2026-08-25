import { describe, expect, it } from "vitest";

import { bindSessionInstrumentation } from "#instrumentation/bind-session.js";
import {
  createInstrumentationHooks,
  type InstrumentationEvent,
  type InstrumentationHooks,
} from "#instrumentation/lifecycle.js";
import type { InstrumentationRuntime } from "#instrumentation/runtime.js";
import { planSessionInstrumentation } from "#instrumentation/session-plan.js";
import { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";

function runtime(input: {
  readonly hooks: InstrumentationHooks;
  readonly sampled?: boolean;
}): InstrumentationRuntime {
  return {
    forceFlush: async () => undefined,
    hooks: input.hooks,
    idGenerator: new AgentSpanIdGenerator(),
    otelSettings: {
      recordInputs: false,
      recordOutputs: false,
      traceChannelRequests: false,
      tracePolicy: () => input.sampled ?? false,
    },
    prepareSessionTrace: async () => ({
      spanId: "1111111111111111",
      traceFlags: input.sampled ? 1 : 0,
      traceId: "44444444444444444444444444444444",
    }),
    runInContext: (_operation, execute) => execute(),
    shutdown: async () => undefined,
  };
}

function plan(input: {
  readonly audience?: "private" | "public";
  readonly hooks: InstrumentationHooks;
  readonly sampled?: boolean;
}) {
  return planSessionInstrumentation({
    runtime: runtime(input),
    session: {
      agentName: "test-agent",
      channel: {
        channelType: "web",
        kind: "channel:web",
        metadata: { audience: input.audience ?? "public" },
      },
      rootSessionId: "session-1",
    },
  });
}

function modelStartedEvent(): InstrumentationEvent {
  return {
    idempotencyKey: "model-1",
    input: { instructions: "secret", messages: [{ role: "user", content: "hello" }] },
    model: { modelId: "test", provider: "test" },
    scope: {
      attemptId: "attempt-1",
      attemptIndex: 0,
      sessionId: "session-1",
      stepIndex: 0,
      turnId: "turn_0",
    },
    type: "model.call.started",
  };
}

describe("bindSessionInstrumentation", () => {
  it("binds current provider implementations without increasing frozen capture", async () => {
    const planningHooks = createInstrumentationHooks([]);
    const frozenPlan = plan({ hooks: planningHooks, sampled: false });
    const received: InstrumentationEvent[] = [];
    const currentHooks = createInstrumentationHooks([
      {
        capture: "content",
        events: {
          "model.call.started": (event) => {
            received.push(event);
          },
        },
        name: "current",
      },
    ]);
    const controls = bindSessionInstrumentation({
      plan: frozenPlan,
      rootSessionId: "session-1",
      runtime: runtime({ hooks: currentHooks, sampled: false }),
      sessionId: "session-1",
    });

    await controls.publish(modelStartedEvent());

    expect(controls.hooks.capturesContent).toBe(false);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ input: undefined });
  });

  it("does not let rejected OTel admission suppress authored content capture", async () => {
    const received: InstrumentationEvent[] = [];
    const hooks = createInstrumentationHooks([
      {
        capture: "content",
        events: {
          "model.call.started": (event) => {
            received.push(event);
          },
        },
        name: "authored",
      },
    ]);
    const frozenPlan = plan({ hooks, sampled: false });
    const controls = bindSessionInstrumentation({
      plan: frozenPlan,
      rootSessionId: "session-1",
      runtime: runtime({ hooks, sampled: false }),
      sessionId: "session-1",
    });

    await controls.publish(modelStartedEvent());

    expect(received[0]).toMatchObject({
      input: { instructions: "secret", messages: [{ role: "user", content: "hello" }] },
    });
  });

  it("keeps admitted private trace content for destination-local redaction", async () => {
    const received: InstrumentationEvent[] = [];
    const hooks = createInstrumentationHooks([
      {
        capture: "content",
        events: {
          "model.call.started": (event) => {
            received.push(event);
          },
        },
        name: "otel",
      },
    ]);
    const frozenPlan = plan({ audience: "private", hooks, sampled: true });
    const controls = bindSessionInstrumentation({
      plan: frozenPlan,
      rootSessionId: "session-1",
      runtime: runtime({ hooks, sampled: true }),
      sessionId: "session-1",
    });

    await controls.publish(modelStartedEvent());

    expect(received[0]).toMatchObject({
      input: { instructions: "secret", messages: [{ role: "user", content: "hello" }] },
    });
  });
});
