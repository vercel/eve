import { describe, expect, it } from "vitest";

import { cancellationSettlement } from "#execution/turn/cancel.js";
import { createDurableSessionState } from "#execution/session/state.js";

const state = createDurableSessionState({
  session: {
    sessionId: "session",
    continuationToken: "alias",
    history: [],
    agent: { modelReference: { id: "model" }, system: "", tools: [] },
    compaction: { threshold: 1000, recentWindowSize: 10 },
    state: {
      "eve.harness.emission": {
        sessionStarted: true,
        sequence: 2,
        stepIndex: 1,
        turnId: "turn_owner",
      },
    },
  },
});

describe("cancellation settlement", () => {
  it("replaces a turn without emitting a waiting boundary", () => {
    const proposal = cancellationSettlement(state, "interrupt");
    expect(proposal.events.map((event) => event.type)).toEqual(["turn.interrupted"]);
    expect(proposal.events[0]).toMatchObject({ data: { sequence: 2, turnId: "turn_owner" } });
    expect(proposal.emissionAfter).toMatchObject({ turnId: "", sequence: 3 });
  });

  it("parks ordinary cancellation and leaves session closure to the terminal finalizer", () => {
    expect(cancellationSettlement(state, "cancel").events.map((event) => event.type)).toEqual([
      "turn.cancelled",
      "session.waiting",
    ]);
    expect(cancellationSettlement(state, "terminal").events.map((event) => event.type)).toEqual([
      "turn.cancelled",
    ]);
  });
});
