import { describe, expect, it } from "vitest";

import { deriveRunFacts } from "#evals/runner/derive-run-facts.js";
import { combineDerivedFacts } from "#evals/runner/execute-task.js";
import type { EveEvalSessionResult } from "#evals/types.js";
import type { SessionEvent, SessionStreamEvent } from "#protocol/session-event.js";

const turnId = "turn_0";

/** `events` as one handle read them, from line `firstLine`, one line each. */
function handle(firstLine: number, events: readonly SessionEvent[]): EveEvalSessionResult {
  const stamped = events.map((event, index): SessionStreamEvent => ({
    ...event,
    meta: {
      at: "2026-10-10T00:00:00.000Z",
      endOfLine: true,
      position: { index: 0, line: firstLine + index },
    },
  }));
  return {
    derived: deriveRunFacts(stamped, { sessionId: "session-1" }),
    events: stamped,
    primary: true,
    sessionId: "session-1",
    state: undefined,
    traceContexts: [],
  };
}

describe("combineDerivedFacts", () => {
  it("reads a held turn's handles as one stream: a resumed turn isn't parked", () => {
    const held = handle(0, [
      { data: { cause: { deliveryId: "d-1" }, follows: null, turnId }, type: "turn.started" },
      {
        data: {
          interactionId: "sign-in-1",
          request: { kind: "sign-in", prompt: "Sign in" },
          subject: { turnId },
        },
        scope: { turnId },
        type: "interaction.opened",
      },
      {
        data: { awaiting: [{ interactionId: "sign-in-1" }], turnId },
        scope: { turnId },
        type: "turn.paused",
      },
    ]);
    const resumed = handle(3, [
      {
        data: { interactionId: "sign-in-1", outcome: "accepted" },
        scope: { turnId },
        type: "interaction.settled",
      },
      { data: { outcome: "completed", turnId }, scope: { turnId }, type: "turn.settled" },
    ]);

    expect(held.derived.parked).toBe(true);
    expect(combineDerivedFacts([held, resumed]).parked).toBe(false);
    expect(combineDerivedFacts([held]).parked).toBe(true);
  });
});
