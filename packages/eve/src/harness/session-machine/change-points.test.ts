import { describe, expect, it } from "vitest";

import { sessionStartedFact, turnStartedFact } from "#harness/session-machine/change-points.js";
import { emptySessionView as emptyView } from "#protocol/session-projection/fold.js";

describe("rebuilt change points", () => {
  it("rebuilds a child session's start with the parent and runtime its row keeps", () => {
    const parent = { callId: "call_1", sessionId: "parent" };
    const runtime = { agentId: "child", eveVersion: "0.78.0" };
    const empty = emptyView();
    const view = {
      ...empty,
      session: { ...empty.session, parent, runtime, status: "open" as const },
    };
    expect(sessionStartedFact(view)).toEqual({
      data: { parent, runtime },
      type: "session.started",
    });
    expect(sessionStartedFact(emptyView())).toEqual({ data: {}, type: "session.started" });
  });

  it("refuses to rebuild the start of a turn its view doesn't hold", () => {
    expect(() => turnStartedFact(emptyView(), "turn_3")).toThrow("Turn turn_3 is missing");
  });
});
