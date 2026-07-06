import { describe, expect, it } from "vitest";

import { resolveRemainingSessionTokenLimits } from "#harness/subagent-token-budget.js";
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

describe("resolveRemainingSessionTokenLimits", () => {
  it("returns false axes for an uncapped session", () => {
    expect(resolveRemainingSessionTokenLimits(createSessionWithUsage({}))).toEqual({
      maxInputTokensPerSession: false,
      maxOutputTokensPerSession: false,
    });
  });

  it("returns the configured limits minus accumulated usage", () => {
    const session = createSessionWithUsage({
      limits: { maxInputTokensPerSession: 1_000_000, maxOutputTokensPerSession: 50_000 },
      usedInputTokens: 300_000,
      usedOutputTokens: 20_000,
    });

    expect(resolveRemainingSessionTokenLimits(session)).toEqual({
      maxInputTokensPerSession: 700_000,
      maxOutputTokensPerSession: 30_000,
    });
  });

  it("returns the full limit when the session has no usage yet", () => {
    const session = createSessionWithUsage({
      limits: { maxInputTokensPerSession: 1_000_000 },
    });

    expect(resolveRemainingSessionTokenLimits(session)).toEqual({
      maxInputTokensPerSession: 1_000_000,
      maxOutputTokensPerSession: false,
    });
  });

  it("clamps an overspent axis to zero", () => {
    const session = createSessionWithUsage({
      limits: { maxInputTokensPerSession: 100_000 },
      usedInputTokens: 150_000,
    });

    expect(resolveRemainingSessionTokenLimits(session)).toEqual({
      maxInputTokensPerSession: 0,
      maxOutputTokensPerSession: false,
    });
  });

  it("splits the remaining quota across the batch's delegated calls", () => {
    const session = createSessionWithUsage({
      limits: { maxInputTokensPerSession: 1_000_000, maxOutputTokensPerSession: 50_000 },
      usedInputTokens: 100_000,
      usedOutputTokens: 20_000,
    });

    expect(resolveRemainingSessionTokenLimits(session, 3)).toEqual({
      maxInputTokensPerSession: 300_000,
      maxOutputTokensPerSession: 10_000,
    });
  });

  it("floors uneven splits so a batch can never exceed the remainder", () => {
    const session = createSessionWithUsage({
      limits: { maxInputTokensPerSession: 100 },
    });

    expect(resolveRemainingSessionTokenLimits(session, 3)).toEqual({
      maxInputTokensPerSession: 33,
      maxOutputTokensPerSession: false,
    });
  });

  it("treats a non-positive fan-out as a single delegation", () => {
    const session = createSessionWithUsage({
      limits: { maxInputTokensPerSession: 100 },
    });

    expect(resolveRemainingSessionTokenLimits(session, 0)).toEqual({
      maxInputTokensPerSession: 100,
      maxOutputTokensPerSession: false,
    });
  });

  it("keeps uncapped parents uncapped regardless of fan-out", () => {
    expect(resolveRemainingSessionTokenLimits(createSessionWithUsage({}), 5)).toEqual({
      maxInputTokensPerSession: false,
      maxOutputTokensPerSession: false,
    });
  });

  it("marks uncapped axes as false", () => {
    const session = createSessionWithUsage({
      limits: { maxOutputTokensPerSession: 50_000 },
      usedOutputTokens: 10_000,
    });

    expect(resolveRemainingSessionTokenLimits(session)).toEqual({
      maxInputTokensPerSession: false,
      maxOutputTokensPerSession: 40_000,
    });
  });
});
