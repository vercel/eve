import { describe, expect, it, vi } from "vitest";

import { MessageResponse } from "#client/message-response.js";
import type { SessionEvent, SessionStreamEvent } from "#protocol/session-event.js";

const meta = { at: "2026-10-13T00:00:00.000Z", position: { index: 0, line: 3 } };
const read = (event: SessionEvent): SessionStreamEvent => ({ ...event, meta });

function responseOf(facts: readonly SessionEvent[]) {
  const events = facts.map(read);
  const cancelTurn = vi.fn(
    async (_turnId: string) => ({ sessionId: "s_1", status: "accepted" }) as const,
  );
  const response = new MessageResponse({
    cancelTurn,
    createStream: async function* () {
      yield* events;
    },
    deliveryId: "d_1",
    sessionId: "s_1",
  });
  return { cancelTurn, response };
}

describe("cancelling a message's response", () => {
  it("cancels the turn that consumed the message", async () => {
    const { cancelTurn, response } = responseOf([
      { data: { deliveryId: "d_1", parts: [], turnId: "turn_1" }, type: "delivery.consumed" },
    ] satisfies SessionEvent[]);
    for await (const _event of response);
    await response.cancel();
    expect(cancelTurn).toHaveBeenCalledWith("turn_1");
  });

  it("cancels the turn an answer resumed, which no delivery of its own started", async () => {
    const { cancelTurn, response } = responseOf([
      {
        data: {
          deliveryId: "d_1",
          interactionId: "i_1",
          responseId: "r_1",
          value: { optionId: "approve" },
        },
        scope: { turnId: "turn_0" },
        type: "response.submitted",
      },
    ] satisfies SessionEvent[]);
    const cancelled = response.cancel();
    for await (const _event of response);
    await cancelled;
    expect(cancelTurn).toHaveBeenCalledWith("turn_0");
  });
});
