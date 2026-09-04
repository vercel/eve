import { describe, expect, it } from "vitest";

import { publicationOperationId } from "./extension/tools/publish.js";

describe("production publish tool", () => {
  it("derives operation identity from trusted parent lineage", () => {
    expect(
      publicationOperationId({
        session: {
          auth: { current: null, initiator: null },
          id: "child-session",
          parent: {
            callId: "delegate-call",
            rootSessionId: "root-session",
            sessionId: "parent-session",
            turn: { id: "parent-turn", sequence: 2 },
          },
          turn: { id: "child-turn", sequence: 0 },
        },
      }),
    ).toBe("root-session:parent-session:parent-turn:delegate-call:child-session");
  });

  it("rejects direct publication sessions", () => {
    expect(() =>
      publicationOperationId({
        session: {
          auth: { current: null, initiator: null },
          id: "root-session",
          turn: { id: "root-turn", sequence: 0 },
        },
      }),
    ).toThrow("delegated child session");
  });
});
