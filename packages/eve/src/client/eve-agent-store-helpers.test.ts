import { describe, expect, it } from "vitest";

import { initialConversationState } from "#client/conversation-reducer.js";
import { isSettledSessionTail } from "#client/eve-agent-store-helpers.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";

const at = "2026-10-09T00:00:00.000Z";
const paused: SessionStreamEvent = {
  data: { awaiting: [{ interactionId: "approval_0" }], turnId: "turn_0" },
  meta: { at, position: { index: 0, line: 7 } },
  scope: { turnId: "turn_0" },
  type: "turn.paused",
};
const answeredForNow: SessionStreamEvent = {
  data: { deliveryId: "d_1", outcome: "awaiting-input", turnId: "turn_0" },
  meta: { at, position: { index: 1, line: 7 } },
  type: "delivery.settled",
};

describe("isSettledSessionTail", () => {
  it("counts a pause on a person that commits with the deliveries it answers", () => {
    expect(isSettledSessionTail([paused, answeredForNow], initialConversationState())).toBe(true);
  });

  it("rests at a boundary that later lines don't move, until a delivery waits again", () => {
    const later: SessionStreamEvent = {
      ...answeredForNow,
      meta: { at, position: { index: 0, line: 8 } },
    };
    expect(isSettledSessionTail([paused, later], initialConversationState())).toBe(true);

    const waiting: SessionStreamEvent = {
      data: { deliveryId: "d_2" },
      meta: { at, position: { index: 0, line: 9 } },
      type: "delivery.admitted",
    };
    expect(isSettledSessionTail([paused, later, waiting], initialConversationState())).toBe(false);
  });
});
