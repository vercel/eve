import { describe, expect, it } from "vitest";

import { Conversation } from "#client/conversation.js";
import { agentCallTurns, isAgentCallContentPending } from "#client/conversation-state.js";
import { stampTestEvent } from "#internal/testing/events.js";
import type { SessionEvent } from "#protocol/session-event.js";
import type { CallRow } from "#protocol/session-projection/tables.js";

const calls: readonly CallRow[] = ["call_one", "call_two"].map((callId) => ({
  callId,
  capability: { kind: "agent", name: "researcher" },
  introducedAt: 0,
  startedAt: "2026-10-10T00:00:00.000Z",
  owner: { runId: "run_parent" },
  outcome: "completed",
  status: "settled",
  taskId: "task_1",
}));

/** A child session's turn for one delivery, which names the call it serves when `callId` is set. */
function childTurn(
  sequence: number,
  deliveryId: string,
  callId: string | undefined,
  settled = true,
): SessionEvent[] {
  const turnId = `turn_${sequence}`;
  const source = {
    channel: "eve",
    ...(callId !== undefined && { caller: { callId, sessionId: "parent" } }),
  };
  return [
    { data: { deliveryId, source }, type: "delivery.admitted" },
    {
      data: {
        cause: { deliveryId },
        follows: sequence === 0 ? null : `turn_${sequence - 1}`,
        turnId,
      },
      scope: { turnId },
      type: "turn.started",
    },
    {
      data: { deliveryId, parts: [{ kind: "text", text: deliveryId }], turnId },
      scope: { turnId },
      type: "delivery.consumed",
    },
    ...(settled
      ? ([
          { data: { outcome: "completed", turnId }, scope: { turnId }, type: "turn.settled" },
          { data: { deliveryId, outcome: "handled", turnId }, type: "delivery.settled" },
        ] satisfies SessionEvent[])
      : []),
  ];
}

function child(events: readonly SessionEvent[]) {
  const conversation = new Conversation();
  conversation.observe(stampTestEvent({ data: {}, type: "session.started" }, 0));
  events.forEach((event, index) => conversation.observe(stampTestEvent(event, index + 1)));
  return conversation.state;
}

describe("agent call attribution", () => {
  it("gives each call the turn that consumed its delivery, in whatever order they arrived", () => {
    const state = child([
      ...childTurn(0, "d_two", "call_two"),
      ...childTurn(1, "d_one", "call_one"),
    ]);

    expect(Object.fromEntries(agentCallTurns(calls, state))).toEqual({
      call_one: ["turn_1"],
      call_two: ["turn_0"],
    });
  });

  it("keeps a call's content pending until the session settles its delivery", () => {
    const working = child([
      ...childTurn(0, "d_one", "call_one"),
      ...childTurn(1, "d_two", "call_two", false),
    ]);
    expect(isAgentCallContentPending(calls, calls[0]!, working)).toBe(false);
    expect(isAgentCallContentPending(calls, calls[1]!, working)).toBe(true);

    // A completed call whose delivery hasn't reached the session yet is still to come.
    const lagging = child(childTurn(0, "d_one", "call_one"));
    expect(isAgentCallContentPending(calls, calls[1]!, lagging)).toBe(true);
  });

  it("reads a session whose deliveries name no call in call order", () => {
    const state = child([...childTurn(0, "d_a", undefined), ...childTurn(1, "d_b", undefined)]);

    expect(Object.fromEntries(agentCallTurns(calls, state))).toEqual({
      call_one: ["turn_0"],
      call_two: ["turn_1"],
    });
  });
});
