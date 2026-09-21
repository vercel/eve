import assert from "node:assert/strict";
import { test } from "node:test";
import type { MessageStreamEvent } from "eve/client";
import { getActiveChatTurn } from "../lib/chat-turn-state.ts";

const event = (type: string, turnId = "turn_4"): MessageStreamEvent =>
  ({
    type,
    data: { turnId },
    meta: { id: type, at: "2026-09-21T04:37:22Z" },
  }) as MessageStreamEvent;

test("late subagent events cannot reactivate a finished parent, including after reload", () => {
  // Observed order: parent ends at 04:37:21, subagent.called arrives at 04:37:22.
  const events = [event("turn.started"), event("turn.completed"), event("session.waiting")];
  for (const type of ["subagent.called", "subagent.called", "subagent.completed"]) {
    events.push(event(type));
    assert.equal(getActiveChatTurn(events), undefined);
    assert.equal(getActiveChatTurn(JSON.parse(JSON.stringify(events))), undefined);
  }
  events.push(event("turn.started", "turn_5"));
  assert.equal(getActiveChatTurn(events), "turn_5");
});

test("text completion and background notifications do not finish an active parent turn", () => {
  const events = [event("turn.started")];
  for (const type of ["message.completed", "step.completed", "subagent.completed"]) {
    events.push(event(type));
    assert.equal(getActiveChatTurn(events), "turn_4");
  }
});

test("all parent termination boundaries clear activity", () => {
  for (const type of [
    "turn.completed",
    "turn.failed",
    "turn.cancelled",
    "session.waiting",
    "session.completed",
    "session.failed",
  ]) {
    assert.equal(
      getActiveChatTurn([event("turn.started"), event(type), event("subagent.called")]),
      undefined,
    );
  }
  assert.equal(getActiveChatTurn([]), undefined);
});

test("a delayed terminal event for an older turn does not end the current turn", () => {
  assert.equal(
    getActiveChatTurn([
      event("turn.started", "turn_3"),
      event("turn.started"),
      event("turn.completed", "turn_3"),
    ]),
    "turn_4",
  );
});
