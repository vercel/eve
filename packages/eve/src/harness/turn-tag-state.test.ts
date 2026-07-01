import { describe, expect, it } from "vitest";

import {
  accumulateTurnUsage,
  getTurnUsageState,
  setTurnUsageState,
} from "#harness/turn-tag-state.js";
import type { HarnessSession } from "#harness/types.js";

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
      usage: { inputTokens: 10, outputTokens: 3, cachedInputTokens: 2 },
    });

    expect(next).toEqual({
      turnId: "turn_0",
      inputTokens: 10,
      outputTokens: 3,
      cacheReadTokens: 2,
      cacheWriteTokens: 0,
    });
  });

  it("accumulates cacheWriteTokens from inputTokenDetails", () => {
    const next = accumulateTurnUsage({
      previous: undefined,
      turnId: "turn_0",
      usage: {
        inputTokens: 1000,
        outputTokens: 50,
        cachedInputTokens: 800,
        inputTokenDetails: { cacheWriteTokens: 200 },
      },
    });

    expect(next).toEqual({
      turnId: "turn_0",
      inputTokens: 1000,
      outputTokens: 50,
      cacheReadTokens: 800,
      cacheWriteTokens: 200,
    });
  });

  it("sums into the previous totals when the turn id matches", () => {
    const previous = {
      turnId: "turn_0",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 8,
      cacheWriteTokens: 5,
    };
    const next = accumulateTurnUsage({
      previous,
      turnId: "turn_0",
      usage: {
        inputTokens: 12,
        outputTokens: 7,
        cachedInputTokens: 4,
        inputTokenDetails: { cacheWriteTokens: 3 },
      },
    });

    expect(next).toEqual({
      turnId: "turn_0",
      inputTokens: 112,
      outputTokens: 57,
      cacheReadTokens: 12,
      cacheWriteTokens: 8,
    });
  });

  it("discards the previous totals when the turn id changes", () => {
    const previous = {
      turnId: "turn_0",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 8,
      cacheWriteTokens: 5,
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
    });

    expect(getTurnUsageState(seeded.state)).toEqual({
      turnId: "turn_0",
      inputTokens: 5,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
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
    });

    expect(seeded.state).toMatchObject({ other: "keep me" });
  });
});
