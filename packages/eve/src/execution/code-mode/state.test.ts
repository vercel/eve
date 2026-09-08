import { describe, expect, it } from "vitest";
import {
  applyCodeModeStateChanges,
  diffCodeModeState,
  adoptCodeModeStateChanges,
} from "./state.js";

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
});
