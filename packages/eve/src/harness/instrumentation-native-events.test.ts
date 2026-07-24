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
      execution: {
        runModelCall: (_id, execute) => execute(),
        runToolCall: (_id, execute) => execute(),
      },
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
    await handleEvent(createStepStartedEvent({ sequence: 0, stepIndex: 0, turnId: "turn-1" }));
    await handleEvent(
      createStepCompletedEvent({
        finishReason: "stop",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn-1",
      }),
    );
    await handleEvent(createTurnCompletedEvent({ sequence: 0, turnId: "turn-1" }));
    await handleEvent(createSessionWaitingEvent("continue-1"));

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
          execution: {
            runModelCall: (_id, execute) => execute(),
            runToolCall: (_id, execute) => execute(),
          },
          publish: async () => {},
        },
        sessionId: "session-1",
      }),
    ).toBeUndefined();
  });
});
