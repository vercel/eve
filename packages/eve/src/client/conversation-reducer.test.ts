import { describe, expect, it } from "vitest";

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
});
