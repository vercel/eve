import { describe, expect, it } from "vitest";

import { Conversation } from "#client/conversation.js";
import {
  agentCallActivity,
  type AgentObservation,
  type ConversationState,
} from "#client/conversation-state.js";
import { stampTestEvent } from "#internal/testing/events.js";
import type { SessionEvent } from "#protocol/session-event.js";

function fold(events: readonly SessionEvent[]): ConversationState {
  const conversation = new Conversation();
  [{ data: {}, type: "session.started" } satisfies SessionEvent, ...events].forEach(
    (event, index) => conversation.observe(stampTestEvent(event, index)),
  );
  return conversation.state;
}

/** A child turn that consumes `deliveryIds` and settles, or keeps working. */
function childTurn(turnId: string, deliveryIds: readonly string[], settled = true): SessionEvent[] {
  return [
    ...deliveryIds.map((deliveryId): SessionEvent => ({
      data: { deliveryId, source: { channel: "subagent" } },
      type: "delivery.admitted",
    })),
    {
      data: { cause: { deliveryId: deliveryIds[0]! }, follows: null, turnId },
      scope: { turnId },
      type: "turn.started",
    },
    ...deliveryIds.map((deliveryId): SessionEvent => ({
      data: { deliveryId, parts: [{ kind: "text", text: deliveryId }], turnId },
      scope: { turnId },
      type: "delivery.consumed",
    })),
    ...(settled
      ? [
          {
            data: { outcome: "completed", turnId },
            scope: { turnId },
            type: "turn.settled",
          } satisfies SessionEvent,
          ...deliveryIds.map((deliveryId): SessionEvent => ({
            data: { deliveryId, outcome: "handled", turnId },
            type: "delivery.settled",
          })),
        ]
      : []),
  ];
}

/** A parent that opened `child` and recorded which call sent each delivery. */
function parent(sent: Readonly<Record<string, string>>, observation: AgentObservation) {
  const state = fold([
    {
      data: { name: "researcher", owner: { callId: "call_one" }, sessionId: "child", stream: "" },
      scope: { turnId: "turn_0" },
      type: "child.opened",
    },
    ...Object.entries(sent).map(([deliveryId, callId]): SessionEvent => ({
      data: { callId, childDeliveryId: deliveryId, sessionId: "child" },
      scope: { turnId: "turn_0" },
      type: "child.sent",
    })),
  ]);
  return {
    ...state,
    agents: { child: { ...state.agents.child!, observation } },
  } satisfies ConversationState;
}

function following(events: readonly SessionEvent[]): AgentObservation {
  return { caughtUp: true, conversation: fold(events), position: 0, status: "caught-up" };
}

describe("agent call activity", () => {
  it("follows each call to the child turns that read its deliveries, and marks shared ones", () => {
    const state = parent(
      { d_one: "call_one", d_two: "call_two", d_three: "call_three" },
      following([...childTurn("turn_0", ["d_one"]), ...childTurn("turn_1", ["d_two", "d_three"])]),
    );

    expect(agentCallActivity(state, "call_one")).toEqual({
      sessions: [
        {
          deliveries: [
            { deliveryId: "d_one", outcome: "handled", status: "settled", turnId: "turn_0" },
          ],
          sessionId: "child",
          turns: [{ sharedWith: [], turnId: "turn_0" }],
        },
      ],
      status: "linked",
    });
    expect(agentCallActivity(state, "call_two")).toMatchObject({
      sessions: [{ turns: [{ sharedWith: ["call_three"], turnId: "turn_1" }] }],
    });
  });

  it("keeps deliveries this reader hasn't seen pending, and calls that sent nothing unlinked", () => {
    const working = parent(
      { d_one: "call_one", d_two: "call_two" },
      following(childTurn("turn_0", ["d_one"], false)),
    );
    expect(agentCallActivity(working, "call_one")).toMatchObject({
      sessions: [{ deliveries: [{ status: "consumed", turnId: "turn_0" }] }],
    });
    expect(agentCallActivity(working, "call_two")).toMatchObject({
      sessions: [{ deliveries: [{ deliveryId: "d_two", status: "unseen" }], turns: [] }],
    });
    expect(agentCallActivity(working, "call_three")).toEqual({ status: "unlinked" });

    const unfollowed = parent({ d_one: "call_one" }, { status: "not-followed" });
    expect(agentCallActivity(unfollowed, "call_one")).toMatchObject({
      sessions: [{ deliveries: [{ status: "unseen" }] }],
    });
  });
});
