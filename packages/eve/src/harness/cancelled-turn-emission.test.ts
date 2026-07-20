import { describe, expect, it } from "vitest";

import { emitCancelledTurn } from "#harness/cancelled-turn-emission.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";

describe("emitCancelledTurn", () => {
  it("emits turn.cancelled → session.waiting and no failure events", async () => {
    const events: HandleMessageStreamEvent[] = [];
    const next = await emitCancelledTurn(
      async (event) => {
        events.push(event);
      },
      { sessionStarted: true, sequence: 3, stepIndex: 2, turnId: "turn_3" },
      "slack:C1:T1",
    );

    expect(events.map((event) => event.type)).toEqual(["turn.cancelled", "session.waiting"]);
    expect(events[0]).toMatchObject({
      data: { sequence: 3, turnId: "turn_3" },
      type: "turn.cancelled",
    });
    expect(events[1]).toEqual({
      data: { continuationToken: "C1:T1", wait: "next-user-message" },
      type: "session.waiting",
    });
    expect(next).toEqual({ sessionStarted: true, sequence: 4, stepIndex: 0, turnId: "" });
  });

  it("reconstructs the turn id when the cancelled step began the turn", async () => {
    // A first-step cancellation aborts before the preamble's state update
    // is persisted: the persisted state still has the between-turns
    // turnId "", but `turn.started` for `turn_${sequence}` is already on
    // the stream.
    const events: HandleMessageStreamEvent[] = [];
    const next = await emitCancelledTurn(
      async (event) => {
        events.push(event);
      },
      { sessionStarted: false, sequence: 0, stepIndex: 0, turnId: "" },
      "eve:eve:test",
    );

    expect(events[0]).toMatchObject({
      data: { sequence: 0, turnId: "turn_0" },
      type: "turn.cancelled",
    });
    // `session.started` was already emitted by the preamble.
    expect(next.sessionStarted).toBe(true);
    expect(next.sequence).toBe(1);
    expect(next.turnId).toBe("");
  });
});
