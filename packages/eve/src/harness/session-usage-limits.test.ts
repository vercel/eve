import { describe, expect, it } from "vitest";

import {
  findRuntimeUsageLimitViolation,
  grantRuntimeUsageLimits,
  remainingRuntimeUsageQuota,
  resolveRuntimeUsageLimits,
} from "#harness/session-usage-limits.js";

const CONFIGURED = { costUsd: 1.5, inputTokens: 100, outputTokens: 50 };

describe("session usage-limit transitions", () => {
  it.each([
    { configured: {}, expected: {}, stored: undefined },
    { configured: CONFIGURED, expected: CONFIGURED, stored: undefined },
    {
      configured: CONFIGURED,
      expected: { costUsd: 3, inputTokens: 250, outputTokens: 50 },
      stored: { costUsd: 3, inputTokens: 250 },
    },
  ])("resolves configured and granted ceilings", ({ configured, expected, stored }) => {
    expect(resolveRuntimeUsageLimits({ configured, stored })).toEqual(expected);
  });

  it.each([
    {
      configured: CONFIGURED,
      expected: { costUsd: 1.5, inputTokens: 100, outputTokens: 50 },
      usage: { costUsd: 0, inputTokens: 0, outputTokens: 0 },
    },
    {
      configured: CONFIGURED,
      expected: { costUsd: 3.25, inputTokens: 450, outputTokens: 170 },
      usage: { costUsd: 1.75, inputTokens: 350, outputTokens: 120 },
    },
    {
      configured: { inputTokens: 100 },
      expected: { inputTokens: 140 },
      usage: { inputTokens: 40, outputTokens: 999 },
    },
  ])("grants one full window from current usage", ({ configured, expected, usage }) => {
    expect(grantRuntimeUsageLimits({ configured, usage })).toEqual(expected);
  });

  it.each([
    {
      expected: { costUsd: false, inputTokens: false, outputTokens: false },
      runtime: {},
      usage: { costUsd: 2, inputTokens: 1_000, outputTokens: 1_000 },
    },
    {
      expected: { costUsd: 1, inputTokens: 60, outputTokens: 40 },
      runtime: CONFIGURED,
      usage: { costUsd: 0.5, inputTokens: 40, outputTokens: 10 },
    },
    {
      expected: { costUsd: 0, inputTokens: 0, outputTokens: 0 },
      runtime: CONFIGURED,
      usage: { costUsd: 2, inputTokens: 150, outputTokens: 80 },
    },
  ])("computes remaining quota without negative values", ({ expected, runtime, usage }) => {
    expect(remainingRuntimeUsageQuota({ runtime, usage })).toEqual(expected);
  });

  it.each([
    {
      configured: CONFIGURED,
      expected: null,
      runtime: CONFIGURED,
      usage: { costUsd: 1.49, inputTokens: 99, outputTokens: 49 },
    },
    {
      configured: CONFIGURED,
      expected: { kind: "input", limit: 100, usedTokens: 100 },
      runtime: CONFIGURED,
      usage: { costUsd: 1.5, inputTokens: 100, outputTokens: 50 },
    },
    {
      configured: CONFIGURED,
      expected: { kind: "output", limit: 50, usedTokens: 50 },
      runtime: CONFIGURED,
      usage: { costUsd: 1.5, inputTokens: 0, outputTokens: 50 },
    },
    {
      configured: { costUsd: 1.5 },
      expected: { kind: "token-cost", limitUsd: 1.5, usedCostUsd: 1.5 },
      runtime: { costUsd: 1.5 },
      usage: { costUsd: 1.5, inputTokens: 0, outputTokens: 0 },
    },
    {
      configured: { inputTokens: 0 },
      expected: { kind: "input", limit: 0, usedTokens: 0 },
      runtime: { inputTokens: 0 },
      usage: { inputTokens: 0, outputTokens: 0 },
    },
    {
      configured: CONFIGURED,
      expected: { kind: "input", limit: 100, usedTokens: 200 },
      runtime: { costUsd: 3, inputTokens: 200, outputTokens: 100 },
      usage: { costUsd: 2, inputTokens: 200, outputTokens: 0 },
    },
  ])("finds the first exhausted axis", ({ configured, expected, runtime, usage }) => {
    expect(findRuntimeUsageLimitViolation({ configured, runtime, usage })).toEqual(expected);
  });
});
