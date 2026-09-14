import { describe, expect, it } from "vitest";

import { resolveParentLineage } from "#instrumentation/parent-lineage.js";

const parent = {
  callId: "initial-call",
  rootSessionId: "root",
  sessionId: "parent",
  turn: { id: "turn-1", sequence: 0 },
};
const adapter = {
  state: {
    callId: "continued-local-call",
    parentContinuationToken: "parent-token",
    parentSessionId: "parent",
    subagentName: "research",
  },
};

describe("parent trace lineage", () => {
  it("uses the existing local adapter's current caller", () => {
    expect(resolveParentLineage(parent, adapter)).toEqual({
      callId: "continued-local-call",
      sessionId: "parent",
      subagentName: "research",
      turnId: "turn-1",
    });
  });

  it("uses the current callback for remote continuations", () => {
    const lineage = resolveParentLineage(parent, undefined, {
      callId: "continued-remote-call",
      subagentName: "research",
      token: "callback-token",
      url: "https://parent.example/callback",
    });
    expect(lineage?.callId).toBe("continued-remote-call");
    expect(lineage?.subagentName).toBe("research");
  });

  it("does not invent delegated lineage from callback metadata", () => {
    expect(resolveParentLineage(undefined, adapter)).toBeUndefined();
    expect(resolveParentLineage(parent, undefined)?.callId).toBe("initial-call");
  });

  it("omits the name when the child did not come through the subagent adapter", () => {
    expect(resolveParentLineage(parent, { state: { kind: "http" } })?.subagentName).toBeUndefined();
    expect(resolveParentLineage(parent, undefined)?.subagentName).toBeUndefined();
    expect(resolveParentLineage(undefined, undefined)).toBeUndefined();
  });
});
