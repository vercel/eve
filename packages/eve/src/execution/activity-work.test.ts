import { describe, expect, it } from "vitest";

import { deriveChildWorkIdentity, deriveRootTurnWorkIdentity } from "#execution/activity-work.js";

describe("activity work identity", () => {
  it("derives root work from the active root turn", () => {
    expect(
      deriveRootTurnWorkIdentity({
        auth: { current: null, initiator: null },
        sessionId: "root",
        turn: { id: "turn-1", sequence: 0 },
      }),
    ).toEqual({
      id: "root:root:turn-1",
      kind: "root-turn",
      rootSessionId: "root",
      rootTurnId: "turn-1",
      sessionId: "root",
      turnId: "turn-1",
    });
  });

  it("preserves immediate parent and root-turn lineage for nested work", () => {
    const root = {
      id: "root:root:turn-1",
      kind: "root-turn" as const,
      rootSessionId: "root",
      rootTurnId: "turn-1",
      sessionId: "root",
      turnId: "turn-1",
    };
    const child = deriveChildWorkIdentity({
      callId: "call-a",
      kind: "subagent",
      name: "research",
      parentSessionId: "root",
      parentTurnId: "turn-1",
      parentWork: root,
    });
    const grandchild = deriveChildWorkIdentity({
      callId: "call-b",
      kind: "subagent",
      name: "tester",
      parentSessionId: "child-a",
      parentTurnId: "child-turn",
      parentWork: child,
    });

    expect(grandchild).toMatchObject({
      id: "work:child-a:child-turn:call-b",
      parentId: child.id,
      rootSessionId: "root",
      rootTurnId: "turn-1",
    });
  });
});
