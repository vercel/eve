import { describe, expect, it } from "vitest";

import {
  accumulateTurnUsage,
  getSessionTokenLimitViolation,
  getSessionTokenUsage,
  getTurnUsageState,
  setTurnUsageState,
} from "#harness/turn-tag-state.js";
import type { HarnessSession } from "#harness/types.js";

const ZERO_SESSION_USAGE = {
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
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
      session: {
        cacheReadTokens: 800,
        cacheWriteTokens: 200,
        inputTokens: 1000,
        outputTokens: 50,
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
      session: {
        cacheReadTokens: 8,
        cacheWriteTokens: 5,
        inputTokens: 100,
        outputTokens: 50,
      },
    };
    const next = accumulateTurnUsage({
      previous,
      turnId: "turn_0",
      usage: {
        cacheReadTokens: 4,
        cacheWriteTokens: 3,
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
      session: {
        cacheReadTokens: 12,
        cacheWriteTokens: 8,
        inputTokens: 112,
        outputTokens: 57,
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
      session: {
        cacheReadTokens: 80,
        cacheWriteTokens: 50,
        inputTokens: 1000,
        outputTokens: 500,
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
      session: {
        cacheReadTokens: 80,
        cacheWriteTokens: 50,
        inputTokens: 1020,
        outputTokens: 505,
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
      inputTokens: 10,
      outputTokens: 3,
      session: {
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        inputTokens: 10,
        outputTokens: 3,
      },
    });

    expect(getSessionTokenLimitViolation({ ...session, limits: testCase.limits })).toEqual(
      testCase.expected,
    );
  });
});
