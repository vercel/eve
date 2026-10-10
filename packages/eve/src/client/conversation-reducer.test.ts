import { describe, expect, it } from "vitest";

import { conversationView } from "#client/conversation-projection.js";
import { conversationReducer } from "#client/conversation-reducer.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { stampTestEvent } from "#internal/testing/events.js";

const turnId = "turn_0";
const facts: SessionEvent[] = [
  {
    data: { cause: { deliveryId: "d_0" }, follows: null, turnId },
    scope: { turnId },
    type: "turn.started",
  },
  {
    data: {
      callId: "call_0",
      capability: { kind: "tool", name: "deploy" },
      owner: { runId: "run_0" },
    },
    scope: { runId: "run_0", turnId },
    type: "call.requested",
  },
  {
    data: {
      interactionId: "approval_0",
      request: {
        kind: "approval",
        options: [{ id: "approve", label: "Approve" }],
        prompt: "Approve deploy?",
      },
      subject: { callId: "call_0" },
    },
    scope: { turnId },
    type: "interaction.opened",
  },
];

function fold(events: readonly SessionEvent[]) {
  return events.reduce(
    (state, event, index) => conversationReducer.reduce(state, stampTestEvent(event, index)),
    conversationReducer.initial(),
  );
}

describe("conversationReducer", () => {
  it("reopens a request whose answer the server refused", () => {
    const answered = conversationReducer.reduce(fold(facts), {
      data: { createdAt: 0, responses: [{ optionId: "approve", requestId: "approval_0" }] },
      type: "client.input.responded",
    });
    expect(answered.inputs.approval_0?.status).toBe("responded");

    const submitted = conversationReducer.reduce(
      answered,
      stampTestEvent(
        {
          data: {
            deliveryId: "d_1",
            interactionId: "approval_0",
            responseId: "response_0",
            value: { optionId: "approve" },
          },
          type: "response.submitted",
        },
        3,
      ),
    );
    const refused = conversationReducer.reduce(
      submitted,
      stampTestEvent(
        {
          data: { outcome: "refused", reason: "Wrong responder.", responseId: "response_0" },
          type: "response.settled",
        },
        4,
      ),
    );

    expect(refused.inputs.approval_0?.status).toBe("open");
    expect(refused.inputs.approval_0?.response).toBeUndefined();
  });

  it("folds an event once when a reducer runs twice with it, as React's strict mode does", () => {
    const usage = stampTestEvent(
      {
        data: {
          kind: "model",
          owner: { runId: "run_0" },
          usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 10, outputTokens: 2 },
        },
        type: "usage.recorded",
      },
      3,
    );
    const before = fold(facts);
    conversationReducer.reduce(before, usage);
    const twice = conversationReducer.reduce(before, usage);

    expect(twice.inputs.approval_0?.status).toBe("open");
    expect(conversationView(twice).usage.total.inputTokens).toBe(10);
  });

  it("updates only the records a fact names", () => {
    const state = fold(facts);
    const next = conversationReducer.reduce(
      state,
      stampTestEvent({ data: { awaiting: [], turnId }, scope: { turnId }, type: "turn.paused" }, 3),
    );

    expect(next.turns[turnId]).toEqual({ status: "active", turnId, waiting: true });
    expect(next.inputs).toBe(state.inputs);
    expect(next.tasks).toBe(state.tasks);
  });
});
