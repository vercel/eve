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
      id: expect.stringMatching(/^root:[a-f0-9]{64}$/),
      kind: "root-turn",
      rootSessionId: "root",
      rootTurnId: "turn-1",
      sessionId: "root",
      turnId: "turn-1",
    });
  });

  it("preserves immediate parent and root-turn lineage for nested work", () => {
    const root = {
      id: "root:fixture",
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
      id: expect.stringMatching(/^work:[a-f0-9]{64}$/),
      parentId: child.id,
      rootSessionId: "root",
      rootTurnId: "turn-1",
    });
  });

  it("keeps colon-containing root tuples distinct", () => {
    const first = deriveRootTurnWorkIdentity({
      auth: { current: null, initiator: null },
      sessionId: "a:b",
      turn: { id: "c", sequence: 0 },
    });
    const second = deriveRootTurnWorkIdentity({
      auth: { current: null, initiator: null },
      sessionId: "a",
      turn: { id: "b:c", sequence: 0 },
    });

    expect(first.id).not.toBe(second.id);
  });

  it("keeps colon-containing child tuples distinct", () => {
    const parentWork = {
      id: "root:fixture",
      kind: "root-turn" as const,
      rootSessionId: "root",
      rootTurnId: "turn",
    };
    const first = deriveChildWorkIdentity({
      callId: "d",
      kind: "subagent",
      name: "first",
      parentSessionId: "a:b",
      parentTurnId: "c",
      parentWork,
    });
    const second = deriveChildWorkIdentity({
      callId: "d",
      kind: "subagent",
      name: "second",
      parentSessionId: "a",
      parentTurnId: "b:c",
      parentWork,
    });

    expect(first.id).not.toBe(second.id);
  });
});
