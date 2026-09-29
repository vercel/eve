import { describe, expect, it } from "vitest";

import { initialConversationState, reduceConversation } from "#client/conversation-reducer.js";
import { stampTestEvent } from "#internal/testing/events.js";
import {
  createActionsRequestedEvent,
  createAgentStartedEvent,
  createMessageAppendedEvent,
  createMessageCompletedEvent,
  createSessionWaitingEvent,
  createStepCompletedEvent,
  createTurnStartedEvent,
} from "#protocol/message.js";
import { applyObservationPage, initialObservation } from "#execution/run-observation/state.js";

const events = [
  createTurnStartedEvent({ turnId: "turn", sequence: 0 }),
  createMessageAppendedEvent({ turnId: "turn", stepIndex: 0, sequence: 1, messageDelta: "Hel" }),
  createMessageCompletedEvent({ turnId: "turn", stepIndex: 0, sequence: 2, message: "Hello" }),
  createMessageCompletedEvent({
    turnId: "turn",
    stepIndex: 1,
    sequence: 3,
    message: "Narration",
    finishReason: "tool-calls",
  }),
].map((event, index) => stampTestEvent(event, index));

describe("indexed run observation", () => {
  it("checkpoints source positions, shared projection and visible completion together", () => {
    const initial = initialObservation("root");
    const prefix = applyObservationPage(
      initial,
      "root",
      events.slice(0, 2).map((event, index) => ({ index, event })),
    );
    const resumed = applyObservationPage(
      JSON.parse(JSON.stringify(prefix)),
      "root",
      events.slice(1).map((event, offset) => ({ index: offset + 1, event })),
    );
    const uninterrupted = applyObservationPage(
      initial,
      "root",
      events.map((event, index) => ({ index, event })),
    );
    expect(resumed.sources).toEqual(uninterrupted.sources);
    expect(resumed.revision).toBe(2);
    expect(uninterrupted.revision).toBe(1);
    expect(resumed.sources.root?.nextIndex).toBe(4);
    expect(resumed.sources.root?.conversation).toEqual(
      events.reduce(reduceConversation, initialConversationState()),
    );
    expect(Object.values(resumed.sources.root!.completedReplies)).toEqual([
      { turnId: "turn", text: "Hello" },
    ]);
    expect(() => applyObservationPage(initial, "root", [{ index: 1, event: events[1]! }])).toThrow(
      /gap/,
    );
  });

  it("scopes equal child session IDs to their parent and preserves independent cursors", () => {
    const child = stampTestEvent(
      createAgentStartedEvent({
        callId: "call",
        name: "researcher",
        parentSessionId: "root",
        sessionId: "shared",
        taskId: "task",
        turnId: "turn",
      }),
    );
    const root = applyObservationPage(initialObservation("root"), "root", [
      { index: 0, event: child },
    ]);
    expect(root.sourceOrder).toEqual(["root", "root/call/shared"]);
    const observed = applyObservationPage(root, "root/call/shared", [
      { index: 0, event: events[0]! },
    ]);
    expect(observed.sources["root/call/shared"]?.nextIndex).toBe(1);
    expect(observed.sources.root?.nextIndex).toBe(1);
    expect(observed.sources.root?.conversation.agents.shared?.observation).toMatchObject({
      status: "following",
    });
  });

  it("advances an ignored source position without publishing a presentation revision", () => {
    const waiting = stampTestEvent(createSessionWaitingEvent());
    const next = applyObservationPage(initialObservation("root"), "root", [
      { index: 0, event: waiting },
    ]);
    expect(next.sources.root?.nextIndex).toBe(1);
    expect(next.revision).toBe(0);
  });

  it("retains narration only when the recorded step has one task_wait action", () => {
    const step = (stepIndex: number, names: readonly string[], textAfter?: string) => [
      createMessageCompletedEvent({
        turnId: "turn",
        stepIndex,
        sequence: 1,
        message: `Waiting at step ${stepIndex}`,
        finishReason: "tool-calls",
      }),
      createActionsRequestedEvent({
        turnId: "turn",
        stepIndex,
        sequence: 2,
        actions: names.map((toolName) => ({
          kind: "tool-call" as const,
          callId: `${stepIndex}-${toolName}`,
          toolName,
          input: {},
        })),
      }),
      ...(textAfter === undefined
        ? []
        : [
            createMessageCompletedEvent({
              turnId: "turn",
              stepIndex,
              sequence: 3,
              message: textAfter,
              finishReason: "tool-calls",
            }),
          ]),
      createStepCompletedEvent({
        turnId: "turn",
        stepIndex,
        sequence: textAfter === undefined ? 3 : 4,
        finishReason: "tool-calls",
      }),
    ];
    const records = [
      createTurnStartedEvent({ turnId: "turn", sequence: 0 }),
      ...step(0, ["task_wait"], "Still working"),
      ...step(1, ["task_wait", "search"]),
    ].map((event, index) => ({ index, event: stampTestEvent(event, index) }));
    const prefix = applyObservationPage(initialObservation("root"), "root", records.slice(0, 3));
    const resumed = applyObservationPage(
      JSON.parse(JSON.stringify(prefix)),
      "root",
      records.slice(3),
    );
    expect(Object.values(resumed.sources.root!.completedReplies)).toEqual([
      { turnId: "turn", text: "Waiting at step 0\nStill working" },
    ]);
    expect(resumed.sources.root?.pendingToolCall).toBeUndefined();
    expect(resumed.sources.root?.nextIndex).toBe(records.length);
  });
});
