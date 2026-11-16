import { afterEach, describe, expect, it, vi } from "vitest";

import { applySessionStateDelta } from "#execution/session/state-delta.js";
import { withSessionStateDelta } from "#execution/session/step-state-delta.js";
import { applyValueDelta, diffValue } from "#shared/value-delta.js";

/** Whether every plain object and array in `value` is frozen. */
function deeplyFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value).every(deeplyFrozen);
}

function dictionary(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.assign(Object.create(null) as Record<string, unknown>, entries);
}

const message = (role: string, content: string) => ({ role, content });

/** The session values here are plain stand-ins; only their shape matters. */
async function run(
  input: Record<string, unknown>,
  work: (input: any) => Promise<Record<string, unknown>>,
): Promise<{ readonly stateDelta: Record<string, any> }> {
  return withSessionStateDelta(input as never, work as never);
}

describe("withSessionStateDelta", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns each changed value as the next frozen version of the given one", async () => {
    const kept = message("user", "hello");
    const history = Object.freeze([kept, message("assistant", "hi")]);
    const sessionState = { turn: 1, tables: dictionary({ a: { n: 1 }, b: { n: 2 } }) };
    const result = await run({ history, sessionState }, async (input) => ({
      history: [...(input.history ?? []), message("user", "next")],
      sessionState: { turn: 2, tables: dictionary({ b: { n: 3 }, a: { n: 1 } }) },
    }));

    const next = result.stateDelta.history;
    expect(next?.kind).toBe("value");
    const value = (next as { value: typeof history }).value;
    expect(value).toEqual([...history, message("user", "next")]);
    // Unchanged entries are the given objects, so Workflow stores only the change.
    expect(value[0]).toBe(kept);
    expect(deeplyFrozen(value)).toBe(true);

    // Removed, reordered and changed entries match the structural delta exactly.
    const state = (result.stateDelta.sessionState as { value: typeof sessionState }).value;
    const expected = applyValueDelta(
      sessionState,
      diffValue(sessionState, { turn: 2, tables: dictionary({ b: { n: 3 }, a: { n: 1 } }) }),
    );
    expect(state).toEqual(expected);
    expect(Object.keys(state.tables)).toEqual(["b", "a"]);
    expect(Object.getPrototypeOf(state.tables)).toBe(null);
    expect(state.tables.a).toBe(sessionState.tables.a);
    expect(deeplyFrozen(state)).toBe(true);
    // The given values are left as they were.
    expect(sessionState.turn).toBe(1);
    expect(Object.isFrozen(sessionState)).toBe(false);
  });

  it("leaves unchanged values out", async () => {
    const history = Object.freeze([message("user", "hello")]);
    const result = await run({ history }, async (input) => ({
      history: input.history,
    }));
    expect(result.stateDelta).toEqual({});
  });

  it("gives step code editable copies of frozen values", async () => {
    const sessionState = Object.freeze({ turn: 1, inner: Object.freeze({ n: 1 }) });
    const result = await run({ sessionState }, async (input) => {
      const state = input.sessionState;
      state.turn = 2;
      state.inner.n = 2;
      return { sessionState: state };
    });
    expect(sessionState).toEqual({ turn: 1, inner: { n: 1 } });
    expect(
      applySessionStateDelta({ sessionState } as never, result.stateDelta as never).sessionState,
    ).toEqual({ turn: 2, inner: { n: 2 } });
  });

  it("returns structural deltas where Workflow stores values in full", async () => {
    vi.stubEnv("WORKFLOW_VM", "quickjs");
    const history = [message("user", "hello")];
    const next = [...history, message("assistant", "hi")];
    const result = await run({ history }, async () => ({ history: next }));
    expect(result.stateDelta.history).toEqual(diffValue(history, next));
  });
});
