import { describe, expect, it } from "vitest";

import { emitCancelledTurn } from "#harness/cancelled-turn-emission.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

const USAGE = {
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.5,
  inputTokens: 120,
  outputTokens: 30,
};

describe("emitCancelledTurn", () => {
  it("emits turn.cancelled → session.waiting with the session's usage and no failure events", async () => {
    const events: UnstampedMessageStreamEvent[] = [];
    const next = await emitCancelledTurn(
      async (event) => {
        events.push(event);
      },
      { sessionStarted: true, sequence: 3, stepIndex: 2, turnId: "turn_3" },
      USAGE,
    );

    expect(events.map((event) => event.type)).toEqual(["turn.cancelled", "session.waiting"]);
    expect(events[0]).toMatchObject({
      data: { sequence: 3, turnId: "turn_3" },
      type: "turn.cancelled",
    });
    expect(events[1]).toEqual({
      data: { continuationToken: "", usage: USAGE, wait: "next-user-message" },
      type: "session.waiting",
    });
    expect(next).toEqual({ sessionStarted: true, sequence: 4, stepIndex: 0, turnId: "" });
  });

  it("reconstructs the turn id when the cancelled step began the turn", async () => {
    // A first-step cancellation aborts before the preamble's state update
    // is persisted: the persisted state still has the between-turns
    // turnId "", but `turn.started` for `turn_${sequence}` is already on
    // the stream.
    const events: UnstampedMessageStreamEvent[] = [];
    const next = await emitCancelledTurn(
      async (event) => {
        events.push(event);
      },
      { sessionStarted: false, sequence: 0, stepIndex: 0, turnId: "" },
      USAGE,
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
