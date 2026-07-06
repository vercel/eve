import { describe, expect, it } from "vitest";

import { SubagentTokenBudgetKey } from "#context/keys.js";
import {
  readSerializedSubagentTokenBudget,
  resolveRemainingSessionTokenBudget,
} from "#harness/subagent-token-budget.js";
import { setTurnUsageState } from "#harness/turn-tag-state.js";
import type { HarnessSession, SessionLimits } from "#harness/types.js";

function createSessionWithUsage(input: {
  readonly limits?: SessionLimits;
  readonly usedInputTokens?: number;
  readonly usedOutputTokens?: number;
}): HarnessSession {
  const base: {
    -readonly [K in keyof HarnessSession]: HarnessSession[K];
  } = {
    agent: { modelReference: { id: "test-model" }, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:test-session",
    history: [],
    sessionId: "test-session",
  };
  if (input.limits !== undefined) {
    base.limits = input.limits;
  }

  if (input.usedInputTokens === undefined && input.usedOutputTokens === undefined) {
    return base;
  }

  const usage = {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    inputTokens: input.usedInputTokens ?? 0,
    outputTokens: input.usedOutputTokens ?? 0,
    sawCost: false,
  };
  return setTurnUsageState(base, { ...usage, session: usage, turnId: "turn_0" });
}

describe("resolveRemainingSessionTokenBudget", () => {
  it("returns undefined for an uncapped session", () => {
    expect(resolveRemainingSessionTokenBudget(createSessionWithUsage({}))).toBeUndefined();
  });

  it("returns the configured limits minus accumulated usage", () => {
    const session = createSessionWithUsage({
      limits: { maxInputTokensPerSession: 1_000_000, maxOutputTokensPerSession: 50_000 },
      usedInputTokens: 300_000,
      usedOutputTokens: 20_000,
    });

    expect(resolveRemainingSessionTokenBudget(session)).toEqual({
      maxInputTokens: 700_000,
      maxOutputTokens: 30_000,
    });
  });

  it("returns the full limit when the session has no usage yet", () => {
    const session = createSessionWithUsage({
      limits: { maxInputTokensPerSession: 1_000_000 },
    });

    expect(resolveRemainingSessionTokenBudget(session)).toEqual({
      maxInputTokens: 1_000_000,
    });
  });

  it("clamps an overspent axis to zero", () => {
    const session = createSessionWithUsage({
      limits: { maxInputTokensPerSession: 100_000 },
      usedInputTokens: 150_000,
    });

    expect(resolveRemainingSessionTokenBudget(session)).toEqual({ maxInputTokens: 0 });
  });

  it("splits the remaining quota across the batch's delegated calls", () => {
    const session = createSessionWithUsage({
      limits: { maxInputTokensPerSession: 1_000_000, maxOutputTokensPerSession: 50_000 },
      usedInputTokens: 100_000,
      usedOutputTokens: 20_000,
    });

    expect(resolveRemainingSessionTokenBudget(session, 3)).toEqual({
      maxInputTokens: 300_000,
      maxOutputTokens: 10_000,
    });
  });

  it("floors uneven splits so a batch can never exceed the remainder", () => {
    const session = createSessionWithUsage({
      limits: { maxInputTokensPerSession: 100 },
    });

    expect(resolveRemainingSessionTokenBudget(session, 3)).toEqual({ maxInputTokens: 33 });
  });

  it("treats a non-positive fan-out as a single delegation", () => {
    const session = createSessionWithUsage({
      limits: { maxInputTokensPerSession: 100 },
    });

    expect(resolveRemainingSessionTokenBudget(session, 0)).toEqual({ maxInputTokens: 100 });
  });

  it("keeps uncapped parents uncapped regardless of fan-out", () => {
    expect(resolveRemainingSessionTokenBudget(createSessionWithUsage({}), 5)).toBeUndefined();
  });

  it("omits uncapped axes from the budget", () => {
    const session = createSessionWithUsage({
      limits: { maxOutputTokensPerSession: 50_000 },
      usedOutputTokens: 10_000,
    });

    expect(resolveRemainingSessionTokenBudget(session)).toEqual({ maxOutputTokens: 40_000 });
  });
});

describe("readSerializedSubagentTokenBudget", () => {
  it("round-trips a serialized budget", () => {
    expect(
      readSerializedSubagentTokenBudget({
        [SubagentTokenBudgetKey.name]: { maxInputTokens: 700_000, maxOutputTokens: 30_000 },
      }),
    ).toEqual({ maxInputTokens: 700_000, maxOutputTokens: 30_000 });
  });

  it("returns undefined when absent", () => {
    expect(readSerializedSubagentTokenBudget({})).toBeUndefined();
  });

  it("degrades malformed values to no inherited budget", () => {
    expect(
      readSerializedSubagentTokenBudget({ [SubagentTokenBudgetKey.name]: "700000" }),
    ).toBeUndefined();
    expect(
      readSerializedSubagentTokenBudget({
        [SubagentTokenBudgetKey.name]: { maxInputTokens: -5, maxOutputTokens: 1.5 },
      }),
    ).toBeUndefined();
  });

  it("keeps valid axes when the other is malformed", () => {
    expect(
      readSerializedSubagentTokenBudget({
        [SubagentTokenBudgetKey.name]: { maxInputTokens: 700_000, maxOutputTokens: "x" },
      }),
    ).toEqual({ maxInputTokens: 700_000 });
  });
});
