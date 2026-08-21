import { describe, expect, it } from "vitest";

import { childProgressWork, rootProgressWork } from "#execution/progress-work.js";

describe("progress work identity", () => {
  it("derives root work from the active root turn", () => {
    expect(
      rootProgressWork({
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
    const child = childProgressWork({
      callId: "call-a",
      kind: "subagent",
      name: "research",
      parentSessionId: "root",
      parentTurnId: "turn-1",
      parentWork: root,
    });
    const grandchild = childProgressWork({
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
