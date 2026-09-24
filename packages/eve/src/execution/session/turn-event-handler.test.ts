import { describe, expect, it } from "vitest";
import { isHookCancellableEvent } from "./turn-event-handler.js";

describe("isHookCancellableEvent", () => {
  it.each([
    "session.started",
    "turn.started",
    "step.started",
    "message.received",
    "actions.requested",
    "action.result",
    "authorization.required",
    "input.requested",
    "message.completed",
    "step.completed",
    "result.completed",
  ])("lets a %s hook cancel the running turn", (type) => {
    expect(isHookCancellableEvent(type)).toBe(true);
  });

  it.each([
    "step.failed",
    "turn.completed",
    "turn.failed",
    "turn.cancelled",
    "session.waiting",
    "session.completed",
    "session.failed",
    "context.cleared",
    "subagent.called",
    "subagent.completed",
    "subagent.event",
    "subagent.started",
    "internal.unlisted",
  ])("ignores cancellation from a %s hook", (type) => {
    expect(isHookCancellableEvent(type)).toBe(false);
  });
});
