import { describe, expect, it } from "vitest";

import { applyObservationPage, initialObservation } from "#execution/run-observation/state.js";
import { stampTestEvent } from "#internal/testing/events.js";
import {
  createAgentStartedEvent,
  createMessageCompletedEvent,
  createSessionFailedEvent,
  createTaskStartedEvent,
  createTurnFailedEvent,
  createTurnStartedEvent,
} from "#protocol/message.js";
import { projectSlackObservation } from "#public/channels/slack/observation/view.js";

describe("Slack observation view", () => {
  it("keeps distinct completed replies and labels unsupported nested observation safely", () => {
    const rootEvents = [
      createTurnStartedEvent({ turnId: "turn", sequence: 0 }),
      createTaskStartedEvent({
        callId: "call",
        kind: "agent",
        name: "<research & inspect>",
        taskId: "task",
        turnId: "turn",
      }),
      createAgentStartedEvent({
        callId: "call",
        name: "research",
        parentSessionId: "root",
        sessionId: "child",
        taskId: "task",
        turnId: "turn",
      }),
      createMessageCompletedEvent({ turnId: "turn", stepIndex: 0, sequence: 1, message: "First" }),
      createMessageCompletedEvent({ turnId: "turn", stepIndex: 1, sequence: 2, message: "Second" }),
    ].map((event, index) => ({ index, event: stampTestEvent(event, index) }));
    const root = applyObservationPage(initialObservation("root"), "root", rootEvents);
    const childEvents = [
      createTurnStartedEvent({ turnId: "child-turn", sequence: 0 }),
      createAgentStartedEvent({
        callId: "nested",
        name: "nested agent",
        parentSessionId: "child",
        sessionId: "grandchild",
        turnId: "child-turn",
      }),
    ].map((event, index) => ({ index, event: stampTestEvent(event, index) }));
    const observed = applyObservationPage(root, "root/call/child", childEvents);
    expect(observed.sources["root/call/child/nested/grandchild"]?.unsupported).toBe(true);
    const view = projectSlackObservation(observed);
    expect(
      view.messages.filter((message) => message.kind === "reply").map((message) => message.text),
    ).toEqual(["First", "Second"]);
    expect(view.messages.find((message) => message.kind === "activity")?.text).toBe(
      "&lt;research &amp; inspect&gt;: working (nested descendants unsupported)",
    );
  });

  it("shows one generic error for a failed session with or without a failed turn", () => {
    const sessionFailure = stampTestEvent(
      createSessionFailedEvent({
        code: "internal",
        message: "private failure details",
        sessionId: "root",
      }),
    );
    const withoutTurn = applyObservationPage(initialObservation("root"), "root", [
      { index: 0, event: sessionFailure },
    ]);
    expect(projectSlackObservation(withoutTurn).messages).toMatchObject([
      { kind: "error", text: "The run failed." },
    ]);
    const withTurn = applyObservationPage(initialObservation("root"), "root", [
      { index: 0, event: stampTestEvent(createTurnStartedEvent({ turnId: "turn", sequence: 0 })) },
      {
        index: 1,
        event: stampTestEvent(
          createTurnFailedEvent({
            code: "internal",
            message: "private failure details",
            sequence: 1,
            turnId: "turn",
          }),
        ),
      },
      { index: 2, event: sessionFailure },
    ]);
    const errors = projectSlackObservation(withTurn).messages.filter(
      (message) => message.kind === "error",
    );
    expect(errors).toEqual([
      { key: "root:error:turn", kind: "error", lifecycle: "retained", text: "The run failed." },
    ]);
  });
});
