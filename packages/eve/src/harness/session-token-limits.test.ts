import { describe, expect, it } from "vitest";

import {
  findRuntimeTokenLimitViolation,
  grantRuntimeTokenLimits,
  remainingRuntimeTokenQuota,
  resolveRuntimeTokenLimits,
} from "#harness/session-token-limits.js";

const CONFIGURED = { inputTokens: 100, outputTokens: 50 };

describe("session token-limit transitions", () => {
  it.each([
    { configured: {}, expected: {}, stored: undefined },
    { configured: CONFIGURED, expected: CONFIGURED, stored: undefined },
    {
      configured: CONFIGURED,
      expected: { inputTokens: 250, outputTokens: 50 },
      stored: { inputTokens: 250 },
    },
  ])("resolves configured and granted ceilings", ({ configured, expected, stored }) => {
    expect(resolveRuntimeTokenLimits({ configured, stored })).toEqual(expected);
  });

  it.each([
    {
      configured: CONFIGURED,
      expected: { inputTokens: 100, outputTokens: 50 },
      usage: { inputTokens: 0, outputTokens: 0 },
    },
    {
      configured: CONFIGURED,
      expected: { inputTokens: 450, outputTokens: 170 },
      usage: { inputTokens: 350, outputTokens: 120 },
    },
    {
      configured: { inputTokens: 100 },
      expected: { inputTokens: 140 },
      usage: { inputTokens: 40, outputTokens: 999 },
    },
  ])("grants one full window from current usage", ({ configured, expected, usage }) => {
    expect(grantRuntimeTokenLimits({ configured, usage })).toEqual(expected);
  });

  it.each([
    {
      expected: { inputTokens: false, outputTokens: false },
      runtime: {},
      usage: { inputTokens: 1_000, outputTokens: 1_000 },
    },
    {
      expected: { inputTokens: 60, outputTokens: 40 },
      runtime: CONFIGURED,
      usage: { inputTokens: 40, outputTokens: 10 },
    },
    {
      expected: { inputTokens: 0, outputTokens: 0 },
      runtime: CONFIGURED,
      usage: { inputTokens: 150, outputTokens: 80 },
    },
  ])("computes remaining quota without negative values", ({ expected, runtime, usage }) => {
    expect(remainingRuntimeTokenQuota({ runtime, usage })).toEqual(expected);
  });

  it.each([
    {
      configured: CONFIGURED,
      expected: null,
      runtime: CONFIGURED,
      usage: { inputTokens: 99, outputTokens: 49 },
    },
    {
      configured: CONFIGURED,
      expected: { kind: "input", limit: 100, usedTokens: 100 },
      runtime: CONFIGURED,
      usage: { inputTokens: 100, outputTokens: 50 },
    },
    {
      configured: CONFIGURED,
      expected: { kind: "output", limit: 50, usedTokens: 50 },
      runtime: CONFIGURED,
      usage: { inputTokens: 0, outputTokens: 50 },
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
      runtime: { inputTokens: 200, outputTokens: 100 },
      usage: { inputTokens: 200, outputTokens: 0 },
    },
  ])("finds the first exhausted axis", ({ configured, expected, runtime, usage }) => {
    expect(
      findRuntimeTokenLimitViolation({
        configured,
        runtime,
        usage,
      }),
    ).toEqual(expected);
  });
});
