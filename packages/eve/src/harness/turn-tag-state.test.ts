import { describe, expect, it } from "vitest";

import {
  accumulateSessionUsage,
  accumulateTurnUsage,
  bumpSessionRuntimeTokenLimits,
  getSessionRemainingTokenQuota,
  getSessionRuntimeTokenLimits,
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

  it("checks usage against the bumped runtime limit after a grant", () => {
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

    const bumped = bumpSessionRuntimeTokenLimits(session);

    // Both axes bump together so a session near two limits gets one prompt.
    expect(getSessionRuntimeTokenLimits(bumped)).toEqual({ inputTokens: 20, outputTokens: 6 });
    expect(getSessionTokenLimitViolation({ ...bumped, limits: session.limits })).toBeNull();

    const laterUsage = { ...usage, inputTokens: 20, outputTokens: 3 };
    const later = setTurnUsageState(bumped, {
      turnId: "turn_1",
      ...laterUsage,
      session: laterUsage,
    });

    // `limit` reports the configured window size; `usedTokens` the lifetime total.
    expect(getSessionTokenLimitViolation({ ...later, limits: session.limits })).toEqual({
      kind: "input",
      limit: 10,
      usedTokens: 20,
    });
  });

  it("every grant moves the runtime limit, even after a large overshoot", () => {
    const usage = {
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      inputTokens: 35,
      outputTokens: 0,
      sawCost: false,
    };
    // A single model call overshot the 10-token window by several windows.
    const session = {
      ...setTurnUsageState(makeSession(), { turnId: "turn_0", ...usage, session: usage }),
      limits: { maxInputTokensPerSession: 10 },
    };

    expect(getSessionTokenLimitViolation(session)?.usedTokens).toBe(35);

    // One approval always unblocks: the runtime limit re-anchors to
    // usage + configured limit rather than incrementing by the limit.
    const bumped = bumpSessionRuntimeTokenLimits(session);
    expect(getSessionRuntimeTokenLimits(bumped)).toEqual({ inputTokens: 45 });
    expect(getSessionTokenLimitViolation({ ...bumped, limits: session.limits })).toBeNull();

    // A second grant cycle moves the ceiling again -- never idempotent.
    const laterUsage = { ...usage, inputTokens: 45 };
    const later = setTurnUsageState(bumped, {
      turnId: "turn_1",
      ...laterUsage,
      session: laterUsage,
    });
    expect(getSessionTokenLimitViolation({ ...later, limits: session.limits })).not.toBeNull();
    const bumpedAgain = bumpSessionRuntimeTokenLimits(later);
    expect(getSessionRuntimeTokenLimits(bumpedAgain)).toEqual({ inputTokens: 55 });
    expect(getSessionTokenLimitViolation({ ...bumpedAgain, limits: session.limits })).toBeNull();
  });

  it("reports remaining quota from the runtime limit", () => {
    const usage = {
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      inputTokens: 4,
      outputTokens: 9,
      sawCost: false,
    };
    const session = {
      ...setTurnUsageState(makeSession(), { turnId: "turn_0", ...usage, session: usage }),
      limits: { maxInputTokensPerSession: 10 },
    };

    expect(getSessionRemainingTokenQuota(session)).toEqual({
      inputTokens: 6,
      outputTokens: false,
    });
    expect(getSessionRemainingTokenQuota(makeSession())).toEqual({
      inputTokens: false,
      outputTokens: false,
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

// --- Combinatorial coverage of the runtime-limit surface -------------------
//
// Dimensions: configured axes {none, input, output, both} x prior grant
// {absent, present} x usage position {zero, below, at ceiling, over ceiling}.
// L_IN / L_OUT are deliberately distinct so axis mix-ups fail loudly.

const L_IN = 100;
const L_OUT = 50;
const RUNTIME_LIMIT_KEY = "eve.harness.sessionRuntimeTokenLimit";

function usageTotals(inputTokens: number, outputTokens: number) {
  return { ...ZERO_SESSION_USAGE, inputTokens, outputTokens };
}

/**
 * Builds a session at a point in its life: optionally granted a continuation
 * while usage stood at `bumpAt`, with lifetime usage now at `used`.
 */
function sessionAt(input: {
  readonly limits?: HarnessSession["limits"];
  readonly bumpAt?: readonly [inputTokens: number, outputTokens: number];
  readonly used?: readonly [inputTokens: number, outputTokens: number];
}): HarnessSession {
  let session = makeSession();
  if (input.limits !== undefined) {
    session = { ...session, limits: input.limits };
  }
  if (input.bumpAt !== undefined) {
    session = setTurnUsageState(session, {
      ...usageTotals(...input.bumpAt),
      session: usageTotals(...input.bumpAt),
      turnId: "turn_grant",
    });
    session = bumpSessionRuntimeTokenLimits(session);
  }
  if (input.used !== undefined) {
    session = setTurnUsageState(session, {
      ...usageTotals(...input.used),
      session: usageTotals(...input.used),
      turnId: "turn_now",
    });
  }
  return session;
}

const BOTH = { maxInputTokensPerSession: L_IN, maxOutputTokensPerSession: L_OUT };
const INPUT_ONLY = { maxInputTokensPerSession: L_IN };
const OUTPUT_ONLY = { maxOutputTokensPerSession: L_OUT };

describe("getSessionRuntimeTokenLimits combinatorics", () => {
  it.each([
    { name: "uncapped, no grant", limits: undefined, bumpAt: undefined, expected: {} },
    {
      name: "input-only, no grant",
      limits: INPUT_ONLY,
      bumpAt: undefined,
      expected: { inputTokens: L_IN },
    },
    {
      name: "output-only, no grant",
      limits: OUTPUT_ONLY,
      bumpAt: undefined,
      expected: { outputTokens: L_OUT },
    },
    {
      name: "both, no grant",
      limits: BOTH,
      bumpAt: undefined,
      expected: { inputTokens: L_IN, outputTokens: L_OUT },
    },
    {
      name: "uncapped stays uncapped after a grant",
      limits: undefined,
      bumpAt: [10, 10],
      expected: {},
    },
    {
      name: "input-only grant bumps only input",
      limits: INPUT_ONLY,
      bumpAt: [30, 999],
      expected: { inputTokens: 130 },
    },
    {
      name: "output-only grant bumps only output",
      limits: OUTPUT_ONLY,
      bumpAt: [999, 20],
      expected: { outputTokens: 70 },
    },
    {
      name: "both axes re-anchor together",
      limits: BOTH,
      bumpAt: [30, 20],
      expected: { inputTokens: 130, outputTokens: 70 },
    },
  ] as const)("$name", ({ limits, bumpAt, expected }) => {
    const session = sessionAt({ ...(limits && { limits }), ...(bumpAt && { bumpAt }) });
    expect(getSessionRuntimeTokenLimits(session)).toEqual(expected);
  });
});

describe("bumpSessionRuntimeTokenLimits combinatorics", () => {
  it.each([
    {
      name: "both capped, zero usage",
      limits: BOTH,
      used: [0, 0],
      stored: { inputTokens: L_IN, outputTokens: L_OUT },
    },
    {
      name: "both capped, multi-window overshoot",
      limits: BOTH,
      used: [350, 120],
      stored: { inputTokens: 450, outputTokens: 170 },
    },
    {
      name: "input-only stores no output ceiling",
      limits: INPUT_ONLY,
      used: [40, 999],
      stored: { inputTokens: 140 },
    },
    {
      name: "output-only stores no input ceiling",
      limits: OUTPUT_ONLY,
      used: [999, 40],
      stored: { outputTokens: 90 },
    },
    { name: "uncapped stores an empty grant", limits: undefined, used: [999, 999], stored: {} },
  ] as const)("$name", ({ limits, used, stored }) => {
    const session = sessionAt({ ...(limits && { limits }), used });
    const bumped = bumpSessionRuntimeTokenLimits(session);
    expect(bumped.state?.[RUNTIME_LIMIT_KEY]).toEqual(stored);
  });

  it("is monotonic across repeated grants", () => {
    let session = sessionAt({ limits: INPUT_ONLY, used: [L_IN, 0] });
    session = bumpSessionRuntimeTokenLimits(session); // ceiling 200
    session = sessionAt({ limits: INPUT_ONLY, bumpAt: [L_IN, 0], used: [200, 0] });
    expect(getSessionRuntimeTokenLimits(session)).toEqual({ inputTokens: 200 });
    const again = bumpSessionRuntimeTokenLimits(session);
    expect(getSessionRuntimeTokenLimits(again)).toEqual({ inputTokens: 300 });
  });

  it("preserves unrelated state and never mutates its input", () => {
    const session = sessionAt({ limits: BOTH, used: [1, 1] });
    const seeded: HarnessSession = { ...session, state: { ...session.state, other: "keep me" } };
    const bumped = bumpSessionRuntimeTokenLimits(seeded);
    expect(bumped.state).toMatchObject({ other: "keep me" });
    expect(seeded.state?.[RUNTIME_LIMIT_KEY]).toBeUndefined();
  });
});

describe("getSessionRemainingTokenQuota combinatorics", () => {
  it.each([
    {
      name: "uncapped axes are false",
      limits: undefined,
      bumpAt: undefined,
      used: [1e9, 1e9],
      expected: { inputTokens: false, outputTokens: false },
    },
    {
      name: "untouched budget is the full limit",
      limits: BOTH,
      bumpAt: undefined,
      used: [0, 0],
      expected: { inputTokens: L_IN, outputTokens: L_OUT },
    },
    {
      name: "partial spend nets out",
      limits: BOTH,
      bumpAt: undefined,
      used: [40, 10],
      expected: { inputTokens: 60, outputTokens: 40 },
    },
    {
      name: "exactly at the ceiling is zero",
      limits: BOTH,
      bumpAt: undefined,
      used: [L_IN, L_OUT],
      expected: { inputTokens: 0, outputTokens: 0 },
    },
    {
      name: "overshoot clamps to zero, never negative",
      limits: BOTH,
      bumpAt: undefined,
      used: [150, 80],
      expected: { inputTokens: 0, outputTokens: 0 },
    },
    {
      name: "a grant refreshes the pool",
      limits: BOTH,
      bumpAt: [L_IN, L_OUT],
      used: [120, 60],
      expected: { inputTokens: 80, outputTokens: 40 },
    },
    {
      name: "mixed: one axis capped, one not",
      limits: INPUT_ONLY,
      bumpAt: undefined,
      used: [40, 1e6],
      expected: { inputTokens: 60, outputTokens: false },
    },
  ] as const)("$name", ({ limits, bumpAt, used, expected }) => {
    const session = sessionAt({ ...(limits && { limits }), ...(bumpAt && { bumpAt }), used });
    expect(getSessionRemainingTokenQuota(session)).toEqual(expected);
  });
});

describe("getSessionTokenLimitViolation combinatorics", () => {
  it.each([
    // input axis, no grant
    { name: "input below limit", limits: BOTH, bumpAt: undefined, used: [99, 0], expected: null },
    {
      name: "input exactly at limit",
      limits: BOTH,
      bumpAt: undefined,
      used: [L_IN, 0],
      expected: { kind: "input", limit: L_IN, usedTokens: L_IN },
    },
    {
      name: "input over limit",
      limits: BOTH,
      bumpAt: undefined,
      used: [150, 0],
      expected: { kind: "input", limit: L_IN, usedTokens: 150 },
    },
    // output axis, no grant
    { name: "output below limit", limits: BOTH, bumpAt: undefined, used: [0, 49], expected: null },
    {
      name: "output exactly at limit",
      limits: BOTH,
      bumpAt: undefined,
      used: [0, L_OUT],
      expected: { kind: "output", limit: L_OUT, usedTokens: L_OUT },
    },
    {
      name: "output over limit",
      limits: BOTH,
      bumpAt: undefined,
      used: [0, 80],
      expected: { kind: "output", limit: L_OUT, usedTokens: 80 },
    },
    // precedence
    {
      name: "both violated reports input first",
      limits: BOTH,
      bumpAt: undefined,
      used: [L_IN, L_OUT],
      expected: { kind: "input", limit: L_IN, usedTokens: L_IN },
    },
    // after a grant at [L_IN, L_OUT]: ceilings are [200, 100]
    {
      name: "input below bumped ceiling",
      limits: BOTH,
      bumpAt: [L_IN, L_OUT],
      used: [199, 0],
      expected: null,
    },
    {
      name: "input at bumped ceiling reports the CONFIGURED limit",
      limits: BOTH,
      bumpAt: [L_IN, L_OUT],
      used: [200, 0],
      expected: { kind: "input", limit: L_IN, usedTokens: 200 },
    },
    {
      name: "input over bumped ceiling",
      limits: BOTH,
      bumpAt: [L_IN, L_OUT],
      used: [260, 0],
      expected: { kind: "input", limit: L_IN, usedTokens: 260 },
    },
    {
      name: "output at bumped ceiling",
      limits: BOTH,
      bumpAt: [L_IN, L_OUT],
      used: [0, 100],
      expected: { kind: "output", limit: L_OUT, usedTokens: 100 },
    },
    // uncapped / partially capped
    {
      name: "uncapped never violates",
      limits: undefined,
      bumpAt: undefined,
      used: [1e9, 1e9],
      expected: null,
    },
    {
      name: "input-only cap ignores runaway output",
      limits: INPUT_ONLY,
      bumpAt: undefined,
      used: [0, 1e9],
      expected: null,
    },
    {
      name: "output-only cap ignores runaway input",
      limits: OUTPUT_ONLY,
      bumpAt: undefined,
      used: [1e9, 0],
      expected: null,
    },
    // the zero-limit degenerate case (exhausted quota inherited by a child):
    // violated before any spend, and a grant of `usage + 0` cannot clear it --
    // which is why enforcement fails zero-limit sessions instead of prompting.
    {
      name: "zero limit violates at zero usage",
      limits: { maxInputTokensPerSession: 0 },
      bumpAt: undefined,
      used: [0, 0],
      expected: { kind: "input", limit: 0, usedTokens: 0 },
    },
    {
      name: "zero limit violates with no usage state at all",
      limits: { maxInputTokensPerSession: 0 },
      bumpAt: undefined,
      used: undefined,
      expected: { kind: "input", limit: 0, usedTokens: 0 },
    },
    {
      name: "zero limit still violated after a grant",
      limits: { maxInputTokensPerSession: 0 },
      bumpAt: [0, 0],
      used: [0, 0],
      expected: { kind: "input", limit: 0, usedTokens: 0 },
    },
  ] as const)("$name", ({ limits, bumpAt, used, expected }) => {
    const session = sessionAt({
      ...(limits && { limits }),
      ...(bumpAt && { bumpAt }),
      ...(used && { used }),
    });
    expect(getSessionTokenLimitViolation(session)).toEqual(expected);
  });
});
