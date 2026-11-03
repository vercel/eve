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

  it("returns each changed value whole, sharing unchanged parts, when state references are on", async () => {
    process.env.WORKFLOW_STATE_REFS = "1";
    const history = Object.freeze([Object.freeze(message("hello"))]) as unknown as Input["history"];
    const settings = { theme: "dark" };
    const input: Input = { history, serializedContext: { count: 1, settings } };

    const result = await withSessionStateDelta(input, async (given) => ({
      history: [...(given.history ?? []), message("next")] as Input["history"],
      serializedContext: { ...given.serializedContext, count: 2 },
    }));

    const nextHistory = result.stateDelta.history;
    const nextContext = result.stateDelta.serializedContext;
    expect(nextHistory?.kind).toBe("value");
    expect(nextContext?.kind).toBe("value");
    const historyValue = (nextHistory as { value: unknown[] }).value;
    const contextValue = (nextContext as { value: Record<string, unknown> }).value;
    expect(historyValue).toHaveLength(2);
    expect(historyValue[0]).toBe(history?.[0]);
    expect(contextValue).toEqual({ count: 2, settings: { theme: "dark" } });
    expect(contextValue.settings).toBe(settings);
    expect(Object.isFrozen(contextValue)).toBe(true);
  });

  it("leaves unchanged values out of the delta", async () => {
    process.env.WORKFLOW_STATE_REFS = "1";
    const input: Input = { serializedContext: { count: 1 } };
    const result = await withSessionStateDelta(input, async (given) => ({
      serializedContext: { ...given.serializedContext },
    }));
    expect(result.stateDelta.serializedContext).toBeUndefined();
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
