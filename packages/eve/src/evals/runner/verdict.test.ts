import { describe, expect, it } from "vitest";

import { computeEvalVerdict } from "#evals/runner/verdict.js";
import type { AssertionResult } from "#evals/types.js";

function assertion(overrides: Partial<AssertionResult>): AssertionResult {
  return {
    name: "a",
    score: 1,
    severity: "gate",
    passed: true,
    ...overrides,
  };
}

describe("computeEvalVerdict", () => {
  it("passes when every assertion passed", () => {
    expect(
      computeEvalVerdict({
        assertions: [assertion({ severity: "gate" }), assertion({ severity: "soft", score: 0.9 })],
      }),
    ).toBe("passed");
  });

  it("fails on any execution error", () => {
    expect(computeEvalVerdict({ error: "boom", assertions: [] })).toBe("failed");
  });

  it("fails when a gate assertion failed", () => {
    expect(
      computeEvalVerdict({
        assertions: [assertion({ severity: "gate", score: 0, passed: false })],
      }),
    ).toBe("failed");
  });

  it("scores (soft fail) when only a soft assertion fell below threshold", () => {
    expect(
      computeEvalVerdict({
        assertions: [
          assertion({ severity: "gate", passed: true }),
          assertion({ severity: "soft", threshold: 0.6, score: 0.3, passed: false }),
        ],
      }),
    ).toBe("scored");
  });

  it("prefers failed over scored when both a gate and a soft assertion failed", () => {
    expect(
      computeEvalVerdict({
        assertions: [
          assertion({ severity: "soft", threshold: 0.6, score: 0.3, passed: false }),
          assertion({ severity: "gate", score: 0, passed: false }),
        ],
      }),
    ).toBe("failed");
  });

  it("passes when a tracked soft assertion has no threshold", () => {
    expect(
      computeEvalVerdict({
        assertions: [assertion({ severity: "soft", score: 0.1, passed: true })],
      }),
    ).toBe("passed");
  });
});
