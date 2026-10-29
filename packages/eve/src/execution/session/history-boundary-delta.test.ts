import { describe, expect, it } from "vitest";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { applySessionStateDelta } from "#execution/session/state-delta.js";
import { withSessionStateDelta } from "#execution/session/step-state-delta.js";
import { readHistoryBoundaries, writeHistoryBoundaries } from "./history-boundaries.js";

const boundaries = [
  { turnId: "one", follows: null, length: 1 },
  { turnId: "two", follows: "one", length: 2 },
];
const history = [
  { role: "assistant" as const, content: "one" },
  { role: "assistant" as const, content: "two" },
];

function initial() {
  const sessionState = createTestSessionState({ sessionId: "session-1" });
  return {
    history,
    serializedContext: {},
    sessionState: {
      ...sessionState,
      snapshot: {
        session: {
          ...sessionState.snapshot.session,
          state: writeHistoryBoundaries(sessionState.snapshot.session.state, boundaries),
        },
      },
    },
  };
}

describe("history boundary deltas", () => {
  it("keeps boundaries on append and invalidates prefixes changed by any history step", async () => {
    const base = initial();
    const append = await withSessionStateDelta(base, async (input) => ({
      history: [...input.history, { role: "assistant" as const, content: "three" }],
    }));
    const appended = applySessionStateDelta(base, append.stateDelta);
    expect(readHistoryBoundaries(appended.sessionState.snapshot.session.state)).toEqual(boundaries);

    const repair = await withSessionStateDelta(appended, async (input) => ({
      history: [
        input.history[0]!,
        { role: "assistant" as const, content: "repaired" },
        input.history[2]!,
      ],
    }));
    const repaired = applySessionStateDelta(appended, repair.stateDelta);
    expect(readHistoryBoundaries(repaired.sessionState.snapshot.session.state)).toEqual([
      boundaries[0],
    ]);
  });

  it("preserves an intentional removal and a newly recorded boundary", async () => {
    const base = initial();
    const delta = await withSessionStateDelta(base, async (input) => ({
      history: [...input.history, { role: "assistant" as const, content: "three" }],
      sessionState: {
        ...input.sessionState,
        snapshot: {
          session: {
            ...input.sessionState.snapshot.session,
            state: writeHistoryBoundaries(input.sessionState.snapshot.session.state, [
              boundaries[0]!,
              { turnId: "three", follows: "two", length: 3 },
            ]),
          },
        },
      },
    }));
    const result = applySessionStateDelta(base, delta.stateDelta);
    expect(readHistoryBoundaries(result.sessionState.snapshot.session.state)).toEqual([
      boundaries[0],
      { turnId: "three", follows: "two", length: 3 },
    ]);
  });
});
