import { describe, expect, it } from "vitest";

import { resolveParentLineage } from "#harness/parent-lineage.js";

const parent = {
  callId: "call-1",
  rootSessionId: "root-1",
  sessionId: "session-1",
  turn: { id: "turn-1", sequence: 0 },
};

describe("resolveParentLineage", () => {
  it("reads the call and turn from the parent and the name from the adapter", () => {
    expect(
      resolveParentLineage(parent, {
        state: {
          callId: "call-1",
          parentContinuationToken: "token-1",
          parentSessionId: "session-1",
          subagentName: "researcher",
        },
      }),
    ).toEqual({
      callId: "call-1",
      sessionId: "session-1",
      subagentName: "researcher",
      turnId: "turn-1",
    });
  });

  it("returns undefined for a top-level session", () => {
    expect(resolveParentLineage(undefined, undefined)).toBeUndefined();
  });

  it("omits the name when the child did not come through the subagent adapter", () => {
    expect(resolveParentLineage(parent, { state: { kind: "http" } })?.subagentName).toBeUndefined();
    expect(resolveParentLineage(parent, undefined)?.subagentName).toBeUndefined();
  });
});
