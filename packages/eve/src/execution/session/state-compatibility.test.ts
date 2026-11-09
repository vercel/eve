import { describe, expect, it } from "vitest";

import { isSessionStateIdleForHandoff } from "#execution/session/handoff-state.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { positionState, withQueuedInput } from "#internal/testing/session-machine.js";
import type { HarnessSession } from "#harness/types.js";

// A session hands off only with nothing open: the projection reports every open turn, and
// execution state holds queued input and retained requests.

function checkpoint(session: Pick<HarnessSession, "state">) {
  const value = createTestSessionState();
  return {
    serializedContext: {},
    sessionState: {
      ...value,
      snapshot: { session: { ...value.snapshot.session, state: session.state } },
    },
  };
}

function betweenTurns(): Pick<HarnessSession, "state"> {
  return {
    state: { ...positionState({ sequence: 1, turnId: "" }), authored: { values: [null, false] } },
  };
}

describe("handoff state inspection", () => {
  it("accepts a session between turns with opaque authored state", () => {
    expect(isSessionStateIdleForHandoff(checkpoint(betweenTurns()))).toBe(true);
  });

  it("refuses an open turn", () => {
    const open = { state: positionState({ sequence: 0, stepIndex: 0, turnId: "turn_0" }) };
    expect(isSessionStateIdleForHandoff(checkpoint(open))).toBe(false);
  });

  it.each([{ signIns: false }, { relays: { request: {} } }, { relays: null }, [], "corrupt"])(
    "refuses retained or malformed requests (%#)",
    (requests) => {
      const state = { ...betweenTurns().state, "eve.runtime.hitl.requests": requests };
      expect(isSessionStateIdleForHandoff(checkpoint({ state }))).toBe(false);
    },
  );

  it("rejects corrupt running work before a retained-request shortcut", () => {
    const state = {
      ...betweenTurns().state,
      "eve.runtime.hitl.requests": { signIns: [] },
      "eve.work": "corrupt",
    };
    expect(() => isSessionStateIdleForHandoff(checkpoint({ state }))).toThrow(
      "Corrupt running-work record",
    );
  });

  it("refuses input the session holds until it can run", () => {
    const queued = withQueuedInput(betweenTurns(), { message: "Alice asks for a summary." });
    expect(isSessionStateIdleForHandoff(checkpoint(queued))).toBe(false);
  });
});
