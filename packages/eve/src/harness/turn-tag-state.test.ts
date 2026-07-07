import { describe, expect, it } from "vitest";

import {
  accumulateSessionUsage,
  accumulateTurnUsage,
  extendSessionTokenBudget,
  getSessionTokenLimitViolation,
  getSessionTokenUsage,
  getTurnUsageState,
  setTurnUsageState,
} from "#harness/turn-tag-state.js";
import type { HarnessSession } from "#harness/types.js";

const ZERO_SESSION_USAGE = {
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  sawCost: false,
};

function makeSession(state?: HarnessSession["state"]): HarnessSession {
  return {
    agent: {
      modelReference: { id: "model_x" },
      system: "",
      tools: [],
    },
    compaction: { recentWindowSize: 4, threshold: 1_000_000 },
    continuationToken: "ct_test",
    history: [],
    sessionId: "wrun_test",
    state,
  };
}

describe("accumulateTurnUsage", () => {
  it("starts from zero when no previous state exists", () => {
    const next = accumulateTurnUsage({
      previous: undefined,
      turnId: "turn_0",
      usage: { cacheReadTokens: 2, inputTokens: 10, outputTokens: 3 },
    });

    expect(next).toEqual({
      turnId: "turn_0",
      inputTokens: 10,
      outputTokens: 3,
      cacheReadTokens: 2,
      cacheWriteTokens: 0,
      costUsd: 0,
      sawCost: false,
      session: {
        ...ZERO_SESSION_USAGE,
        cacheReadTokens: 2,
        inputTokens: 10,
        outputTokens: 3,
      },
    });
  });

  it("accumulates cache write tokens from normalized usage", () => {
    const next = accumulateTurnUsage({
      previous: undefined,
      turnId: "turn_0",
      usage: {
        cacheReadTokens: 800,
        cacheWriteTokens: 200,
        inputTokens: 1000,
        outputTokens: 50,
      },
    });

    expect(next).toEqual({
      turnId: "turn_0",
      inputTokens: 1000,
      outputTokens: 50,
      cacheReadTokens: 800,
      cacheWriteTokens: 200,
      costUsd: 0,
      sawCost: false,
      session: {
        cacheReadTokens: 800,
        cacheWriteTokens: 200,
        costUsd: 0,
        inputTokens: 1000,
        outputTokens: 50,
        sawCost: false,
      },
    });
  });

  it("accumulates gateway cost from normalized usage", () => {
    const next = accumulateTurnUsage({
      previous: undefined,
      turnId: "turn_0",
      usage: {
        costUsd: 0.0123,
      },
    });

    expect(next).toEqual({
      turnId: "turn_0",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.0123,
      sawCost: true,
      session: {
        ...ZERO_SESSION_USAGE,
        costUsd: 0.0123,
        sawCost: true,
      },
    });
  });

  it("sums into the previous totals when the turn id matches", () => {
    const previous = {
      turnId: "turn_0",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 8,
      cacheWriteTokens: 5,
      costUsd: 0.01,
      sawCost: true,
      session: {
        cacheReadTokens: 8,
        cacheWriteTokens: 5,
        costUsd: 0.01,
        inputTokens: 100,
        outputTokens: 50,
        sawCost: true,
      },
    };
    const next = accumulateTurnUsage({
      previous,
      turnId: "turn_0",
      usage: {
        cacheReadTokens: 4,
        cacheWriteTokens: 3,
        costUsd: 0.02,
        inputTokens: 12,
        outputTokens: 7,
      },
    });

    expect(next).toEqual({
      turnId: "turn_0",
      inputTokens: 112,
      outputTokens: 57,
      cacheReadTokens: 12,
      cacheWriteTokens: 8,
      costUsd: 0.03,
      sawCost: true,
      session: {
        cacheReadTokens: 12,
        cacheWriteTokens: 8,
        costUsd: 0.03,
        inputTokens: 112,
        outputTokens: 57,
        sawCost: true,
      },
    });
  });

  it("resets turn totals and keeps session totals when the turn id changes", () => {
    const previous = {
      turnId: "turn_0",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 8,
      cacheWriteTokens: 5,
      costUsd: 0.01,
      sawCost: true,
      session: {
        cacheReadTokens: 80,
        cacheWriteTokens: 50,
        costUsd: 0.05,
        inputTokens: 1000,
        outputTokens: 500,
        sawCost: true,
      },
    };
    const next = accumulateTurnUsage({
      previous,
      turnId: "turn_1",
      usage: { inputTokens: 20, outputTokens: 5 },
    });

    expect(next).toEqual({
      turnId: "turn_1",
      inputTokens: 20,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      sawCost: false,
      session: {
        cacheReadTokens: 80,
        cacheWriteTokens: 50,
        costUsd: 0.05,
        inputTokens: 1020,
        outputTokens: 505,
        sawCost: true,
      },
    });
  });

  it("treats missing token fields as zero", () => {
    const next = accumulateTurnUsage({
      previous: undefined,
      turnId: "turn_0",
      usage: {},
    });

    expect(next).toEqual({
      turnId: "turn_0",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      sawCost: false,
      session: ZERO_SESSION_USAGE,
    });
  });
});

describe("session state round-trip", () => {
  it("setTurnUsageState writes a fresh state slot the getter can read back", () => {
    const seeded = setTurnUsageState(makeSession(), {
      turnId: "turn_0",
      inputTokens: 5,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      sawCost: false,
      session: {
        ...ZERO_SESSION_USAGE,
        inputTokens: 5,
        outputTokens: 1,
      },
    });

    expect(getTurnUsageState(seeded.state)).toEqual({
      turnId: "turn_0",
      inputTokens: 5,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      sawCost: false,
      session: {
        ...ZERO_SESSION_USAGE,
        inputTokens: 5,
        outputTokens: 1,
      },
    });
  });

  it("getTurnUsageState returns undefined when no state has been stored yet", () => {
    expect(getTurnUsageState(undefined)).toBeUndefined();
    expect(getTurnUsageState({})).toBeUndefined();
  });

  it("preserves unrelated session state slots when writing", () => {
    const seeded = setTurnUsageState(makeSession({ other: "keep me" }), {
      turnId: "turn_0",
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 1,
      cacheWriteTokens: 0,
      costUsd: 0,
      sawCost: false,
      session: {
        ...ZERO_SESSION_USAGE,
        cacheReadTokens: 1,
        inputTokens: 1,
        outputTokens: 1,
      },
    });

    expect(seeded.state).toMatchObject({ other: "keep me" });
  });
});

describe("session token limits", () => {
  it("reads zero session usage before token state exists", () => {
    expect(getSessionTokenUsage(makeSession())).toEqual(ZERO_SESSION_USAGE);
  });

  it.each([
    {
      expected: { kind: "input", limit: 10, usedTokens: 10 },
      limits: { maxInputTokensPerSession: 10 },
    },
    {
      expected: { kind: "output", limit: 3, usedTokens: 3 },
      limits: { maxOutputTokensPerSession: 3 },
    },
  ])("reports the first exhausted $expected.kind limit", (testCase) => {
    const session = setTurnUsageState(makeSession(), {
      turnId: "turn_0",
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      inputTokens: 10,
      outputTokens: 3,
      sawCost: false,
      session: {
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        inputTokens: 10,
        outputTokens: 3,
        sawCost: false,
      },
    });

    expect(getSessionTokenLimitViolation({ ...session, limits: testCase.limits })).toEqual(
      testCase.expected,
    );
  });

  it("measures limits from the granted budget baseline after extendSessionTokenBudget", () => {
    const usage = {
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      inputTokens: 10,
      outputTokens: 3,
      sawCost: false,
    };
    const session = {
      ...setTurnUsageState(makeSession(), { turnId: "turn_0", ...usage, session: usage }),
      limits: { maxInputTokensPerSession: 10, maxOutputTokensPerSession: 3 },
    };

    expect(getSessionTokenLimitViolation(session)).toEqual({
      kind: "input",
      limit: 10,
      usedTokens: 10,
    });

    const extended = extendSessionTokenBudget(session);

    // Both windows reset together so a session near two limits gets one prompt.
    expect(getSessionTokenLimitViolation({ ...extended, limits: session.limits })).toBeNull();

    const laterUsage = { ...usage, inputTokens: 20, outputTokens: 3 };
    const later = setTurnUsageState(extended, {
      turnId: "turn_1",
      ...laterUsage,
      session: laterUsage,
    });

    expect(getSessionTokenLimitViolation({ ...later, limits: session.limits })).toEqual({
      kind: "input",
      limit: 10,
      usedTokens: 10,
    });
  });
});

describe("accumulateSessionUsage", () => {
  it("folds a child's totals into the session without touching turn totals", () => {
    const previous = accumulateTurnUsage({
      previous: undefined,
      turnId: "turn_1",
      usage: { inputTokens: 100, outputTokens: 10 },
    });

    const next = accumulateSessionUsage({
      previous,
      usage: { cacheReadTokens: 5, cacheWriteTokens: 2, inputTokens: 400, outputTokens: 40 },
    });

    // Turn-scoped totals unchanged: the child's spend is not this turn's
    // own model-call spend.
    expect(next.turnId).toBe("turn_1");
    expect(next.inputTokens).toBe(100);
    expect(next.outputTokens).toBe(10);
    expect(next.session).toMatchObject({
      cacheReadTokens: 5,
      cacheWriteTokens: 2,
      inputTokens: 500,
      outputTokens: 50,
    });
  });

  it("starts from zero when no usage state exists yet", () => {
    const next = accumulateSessionUsage({
      previous: undefined,
      usage: { inputTokens: 400, outputTokens: 40 },
    });

    expect(next.inputTokens).toBe(0);
    expect(next.session).toMatchObject({ inputTokens: 400, outputTokens: 40 });
  });
});
