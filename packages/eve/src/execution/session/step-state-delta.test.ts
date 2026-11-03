import { afterEach, describe, expect, it } from "vitest";

import type { SessionStateValues } from "#execution/session/state-delta.js";
import { withSessionStateDelta } from "#execution/session/step-state-delta.js";
import { diffValue } from "#shared/value-delta.js";

type Input = Partial<SessionStateValues>;

const message = (content: string) => ({ role: "user", content }) as const;

describe("withSessionStateDelta", () => {
  afterEach(() => {
    delete process.env.WORKFLOW_STATE_REFS;
  });

  it("returns each changed value whole and frozen when state references are on", async () => {
    process.env.WORKFLOW_STATE_REFS = "1";
    const history = Object.freeze([Object.freeze(message("hello"))]) as unknown as Input["history"];
    const serializedContext = Object.freeze({
      count: 1,
      settings: Object.freeze({ theme: "dark" }),
    });
    const input: Input = { history, serializedContext };

    const result = await withSessionStateDelta(input, async (given) => {
      // Step code edits its working copy in place, as channel adapters do.
      (given.serializedContext as { count: number }).count = 2;
      return {
        history: [...(given.history ?? []), message("next")] as Input["history"],
        serializedContext: given.serializedContext,
      };
    });

    const nextHistory = result.stateDelta.history as { kind: string; value: unknown[] };
    const nextContext = result.stateDelta.serializedContext as {
      kind: string;
      value: Record<string, unknown>;
    };
    expect(nextHistory.kind).toBe("value");
    expect(nextHistory.value).toEqual([message("hello"), message("next")]);
    expect(nextContext.kind).toBe("value");
    expect(nextContext.value).toEqual({ count: 2, settings: { theme: "dark" } });
    expect(Object.isFrozen(nextContext.value)).toBe(true);
    expect(serializedContext.count).toBe(1);
  });

  it("leaves unchanged values out of the delta", async () => {
    process.env.WORKFLOW_STATE_REFS = "1";
    const input: Input = { serializedContext: { count: 1 } };
    const result = await withSessionStateDelta(input, async (given) => ({
      serializedContext: { ...given.serializedContext },
    }));
    expect(result.stateDelta.serializedContext).toBeUndefined();
  });

  it("gives step code editable copies of frozen values when state references are off", async () => {
    const serializedContext = Object.freeze({ count: 1 });
    const result = await withSessionStateDelta({ serializedContext }, async (given) => {
      (given.serializedContext as { count: number }).count = 2;
      return { serializedContext: given.serializedContext };
    });
    expect(result.stateDelta.serializedContext).toEqual(diffValue({ count: 1 }, { count: 2 }));
    expect(serializedContext.count).toBe(1);
  });

  it("returns the usual structural delta when state references are off", async () => {
    const before = { count: 1, settings: { theme: "dark" } };
    const after = { ...before, count: 2 };
    const result = await withSessionStateDelta({ serializedContext: before }, async () => ({
      serializedContext: after,
    }));
    expect(result.stateDelta.serializedContext).toEqual(diffValue(before, after));
  });
});
