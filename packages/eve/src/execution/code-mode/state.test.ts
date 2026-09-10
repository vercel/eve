import { describe, expect, it } from "vitest";
import {
  applyCodeModeStateChanges,
  approvedToolStateChange,
  codeModeMutableState,
  diffCodeModeState,
  adoptCodeModeStateChanges,
} from "./state.js";

const APPROVED = "eve.runtime.hitl.approvedTools";

function withSnapshot(session: Record<string, unknown>) {
  return { serializedContext: {}, sessionState: { snapshot: { session } } } as never;
}

describe("Code Mode state changes", () => {
  it("merges parallel file reads without losing either stamp", () => {
    const before = { serializedContext: {} };
    const first = { serializedContext: { files: { byTarget: { a: { hash: "a" } } } } };
    const second = { serializedContext: { files: { byTarget: { b: { hash: "b" } } } } };
    const merged = applyCodeModeStateChanges(first, diffCodeModeState(before, second));
    expect(merged).toEqual({
      serializedContext: { files: { byTarget: { a: { hash: "a" }, b: { hash: "b" } } } },
    });
  });

  it("preserves unrelated parent edits and deletions", () => {
    const before = { todos: ["old"], removed: true, other: 1 };
    const changes = diffCodeModeState(before, { todos: ["new"], other: 1 });
    expect(applyCodeModeStateChanges({ ...before, other: 2 }, changes)).toEqual({
      todos: ["new"],
      other: 2,
    });
    expect(before.removed).toBe(true);
  });

  it("rejects conflicting writes instead of replacing newer parent state", () => {
    const before = { todos: ["old"] };
    const changes = diffCodeModeState(before, { todos: ["program"] });
    const parent = { todos: ["parent"] };
    expect(() => applyCodeModeStateChanges(parent, changes)).toThrow("CODE_MODE_STATE_CONFLICT");
    expect(parent.todos).toEqual(["parent"]);
  });

  it("accepts replay of an already-applied update", () => {
    const after = { value: 2 };
    expect(applyCodeModeStateChanges(after, diffCodeModeState({ value: 1 }, after))).toEqual(after);
  });

  it("merges sandbox updates without replacing parent session state", () => {
    const state = {
      serializedContext: {},
      sessionState: {
        snapshot: {
          session: {
            state: { agents: ["new-child"] },
            sandboxState: { initialized: false, session: null },
          },
        },
      },
    } as never;
    const changes = diffCodeModeState(
      { sandboxState: { initialized: false, session: null } },
      { sandboxState: { initialized: true, session: { id: "sandbox" } } },
    );
    expect(adoptCodeModeStateChanges(state, changes).sessionState.snapshot?.session).toMatchObject({
      state: { agents: ["new-child"] },
      sandboxState: { initialized: true, session: { id: "sandbox" } },
    });
  });

  it("exposes recorded approvals keyed by name and leaves them out when none exist", () => {
    expect(codeModeMutableState(withSnapshot({}))).toEqual({
      serializedContext: {},
      sandboxState: undefined,
      approvedTools: undefined,
    });
    expect(
      codeModeMutableState(withSnapshot({ state: { [APPROVED]: ["gated", "deploy:eu"] } }))
        .approvedTools,
    ).toEqual({ gated: true, "deploy:eu": true });
  });

  it("records a granted approval next to existing ones without touching other session state", () => {
    const state = withSnapshot({ state: { agents: ["child"], [APPROVED]: ["earlier"] } });
    const adopted = adoptCodeModeStateChanges(state, [approvedToolStateChange("gated")]);
    expect(adopted.sessionState.snapshot?.session.state).toEqual({
      agents: ["child"],
      [APPROVED]: ["earlier", "gated"],
    });
  });

  it("merges approvals granted in one batch and accepts a key the parent already holds", () => {
    const state = withSnapshot({ state: { [APPROVED]: ["gated"] } });
    const adopted = adoptCodeModeStateChanges(state, [
      approvedToolStateChange("gated"),
      approvedToolStateChange("first"),
      approvedToolStateChange("second"),
    ]);
    expect(adopted.sessionState.snapshot?.session.state?.[APPROVED]).toEqual([
      "gated",
      "first",
      "second",
    ]);
  });

  it("keeps the session state object when no approval changed", () => {
    const session = { state: { agents: ["child"] }, sandboxState: null };
    const adopted = adoptCodeModeStateChanges(withSnapshot(session), [
      { path: ["serializedContext", "todo"], before: undefined, after: ["x"] },
    ]);
    expect(adopted.serializedContext).toEqual({ todo: ["x"] });
    expect(adopted.sessionState.snapshot?.session.state).toBe(session.state);
  });

  it("diffs an approval granted during a nested step into the same change shape", () => {
    const before = { sandboxState: undefined, approvedTools: undefined };
    const after = { sandboxState: undefined, approvedTools: { gated: true } };
    expect(diffCodeModeState(before, after)).toEqual([approvedToolStateChange("gated")]);
  });
});
