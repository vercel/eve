import { describe, expect, it } from "vitest";

import {
  createSessionStartedEvent,
  createSessionWaitingEvent,
  createStepCompletedEvent,
  createStepStartedEvent,
  createTurnCompletedEvent,
  createTurnStartedEvent,
} from "#protocol/message.js";
import { createInstrumentationHandleEvent } from "#harness/instrumentation-native-events.js";
import type { InstrumentationHooks } from "#harness/instrumentation-lifecycle.js";

describe("createInstrumentationHandleEvent", () => {
  it("publishes native lifecycle transitions after durable handling", async () => {
    const order: string[] = [];
    const hooks: InstrumentationHooks = {
      after: async () => {},
      before: async () => {},
      publish: async (event) => {
        order.push(`lifecycle:${event.type}`);
      },
    };
    const handleEvent = createInstrumentationHandleEvent({
      agentName: "weather",
      handleEvent: async (event) => {
        order.push(`durable:${event.type}`);
      },
      hooks,
      sessionId: "session-1",
    })!;

    await handleEvent(createSessionStartedEvent());
    await handleEvent(createTurnStartedEvent({ sequence: 0, turnId: "turn-1" }));
    await handleEvent(
      createStepStartedEvent({
        modelId: "openai/gpt-5.5",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn-1",
      }),
    );
    await handleEvent(
      createStepCompletedEvent({
        finishReason: "stop",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn-1",
      }),
    );
    await handleEvent(createTurnCompletedEvent({ sequence: 0, turnId: "turn-1" }));
    await handleEvent(createSessionWaitingEvent());

    expect(order).toEqual([
      "durable:session.started",
      "lifecycle:session.started",
      "durable:turn.started",
      "lifecycle:turn.started",
      "durable:step.started",
      "durable:step.completed",
      "durable:turn.completed",
      "lifecycle:turn.completed",
      "durable:session.waiting",
      "lifecycle:session.waiting",
    ]);
  });

  it("does not change execution mode when hooks have no durable handler", () => {
    expect(
      createInstrumentationHandleEvent({
        hooks: {
          after: async () => {},
          before: async () => {},
          publish: async () => {},
        },
        sessionId: "session-1",
      }),
    ).toBeUndefined();
  });

  it("uses the restored turn id when a continuation step emits a session transition", async () => {
    const events: unknown[] = [];
    const handleEvent = createInstrumentationHandleEvent({
      handleEvent: async () => {},
      hooks: {
        after: async () => {},
        before: async () => {},
        publish: async (event) => {
          events.push(event);
        },
      },
      sessionId: "session-1",
      turnId: "turn-1",
    })!;

    await handleEvent(createSessionWaitingEvent());

    expect(events).toEqual([{ sessionId: "session-1", turnId: "turn-1", type: "session.waiting" }]);
  });

  it("carries the dispatch lineage onto every turn a child session starts", async () => {
    const events: { readonly type: string }[] = [];
    const parentLineage = {
      callId: "call-7",
      sessionId: "session-1",
      subagentName: "researcher",
      turnId: "turn-1",
    };
    const handleEvent = createInstrumentationHandleEvent({
      handleEvent: async () => {},
      hooks: {
        after: async () => {},
        before: async () => {},
        publish: async (event) => {
          events.push(event);
        },
      },
      parentLineage,
      rootSessionId: "session-1",
      sessionId: "child-1",
    })!;

    await handleEvent(createTurnStartedEvent({ sequence: 0, turnId: "child-turn-1" }));
    await handleEvent(createTurnStartedEvent({ sequence: 1, turnId: "child-turn-2" }));

    expect(events.filter((event) => event.type === "turn.started")).toEqual([
      {
        parentLineage,
        parentTraceContext: undefined,
        rootSessionId: "session-1",
        sequence: 0,
        sessionId: "child-1",
        turnId: "child-turn-1",
        type: "turn.started",
      },
      {
        parentLineage,
        parentTraceContext: undefined,
        rootSessionId: "session-1",
        sequence: 1,
        sessionId: "child-1",
        turnId: "child-turn-2",
        type: "turn.started",
      },
    ]);
  });
});
