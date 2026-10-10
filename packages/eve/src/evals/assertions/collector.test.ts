import { describe, expect, it } from "vitest";

import { AssertionCollector } from "#evals/assertions/collector.js";
import { createEmptyDerivedFacts } from "#evals/runner/derive-run-facts.js";
import { computeEvalVerdict } from "#evals/runner/verdict.js";
import type { EveEvalTaskResult } from "#evals/types.js";

function taskResult(): EveEvalTaskResult {
  return {
    derived: createEmptyDerivedFacts(),
    events: [],
    finalMessage: null,
    output: null,
    status: "completed",
    traceContexts: [],
  };
}

describe("AssertionCollector.recordScore", () => {
  it("records a score with no verdict that does not affect the eval", async () => {
    const collector = new AssertionCollector();
    collector.recordScore(0.82).label("fidelity");
    collector
      .recordScore({
        score: 0,
        message: "nothing matched",
        metadata: { hits: 0 },
      })
      .label("misses");

    const assertions = await collector.finalize(taskResult());

    expect(assertions).toEqual([
      expect.objectContaining({
        name: "score [fidelity]",
        key: "fidelity",
        score: 0.82,
        severity: "soft",
        threshold: undefined,
        passed: undefined,
        errored: false,
      }),
      expect.objectContaining({
        key: "misses",
        score: 0,
        passed: undefined,
        message: "nothing matched",
        metadata: { hits: 0 },
      }),
    ]);
    expect(computeEvalVerdict({ assertions })).toBe("passed");
  });

  it("keeps the score when a gate threshold fails", async () => {
    const collector = new AssertionCollector();
    collector.recordScore(Promise.resolve(0.82)).label("fidelity").gate(0.9);

    const assertions = await collector.finalize(taskResult());

    expect(assertions[0]).toMatchObject({
      key: "fidelity",
      score: 0.82,
      severity: "gate",
      threshold: 0.9,
      passed: false,
      errored: false,
    });
    expect(computeEvalVerdict({ assertions })).toBe("failed");
  });

  it("passes exactly at the threshold and only demotes under a soft bar", async () => {
    const collector = new AssertionCollector();
    collector.recordScore(0.9).label("exact").gate(0.9);
    collector.recordScore(0.5).label("wording").atLeast(0.6);

    const assertions = await collector.finalize(taskResult());

    expect(
      assertions.map(({ severity, threshold, passed }) => ({ severity, threshold, passed })),
    ).toEqual([
      { severity: "gate", threshold: 0.9, passed: true },
      { severity: "soft", threshold: 0.6, passed: false },
    ]);
    expect(computeEvalVerdict({ assertions })).toBe("scored");
  });

  it("reports the implicit gate threshold of 1", async () => {
    const collector = new AssertionCollector();
    collector.recordScore(1).label("full").gate();
    collector.recordScore(0.99).label("partial").gate();

    const assertions = await collector.finalize(taskResult());

    expect(assertions.map(({ threshold, passed }) => ({ threshold, passed }))).toEqual([
      { threshold: 1, passed: true },
      { threshold: 1, passed: false },
    ]);
  });

  it("reports a thrown evaluator as an errored outcome with no score", async () => {
    const collector = new AssertionCollector();
    collector
      .recordScore(Promise.reject(new Error("model unavailable")))
      .label("judge")
      .atLeast(0.5);
    collector.recordScore(0.82).label("fidelity");

    const assertions = await collector.finalize(taskResult());

    expect(assertions[0]).toMatchObject({
      key: "judge",
      severity: "gate",
      passed: false,
      errored: true,
      message: "model unavailable",
    });
    expect(assertions[0]?.score).toBeUndefined();
    expect(assertions[0]?.threshold).toBeUndefined();
    expect(assertions[1]).toMatchObject({ key: "fidelity", score: 0.82, passed: undefined });
    expect(computeEvalVerdict({ assertions })).toBe("failed");
  });

  it("treats a non-finite score as an errored outcome", async () => {
    const collector = new AssertionCollector();
    collector.recordScore(Number.NaN);

    const [assertion] = await collector.finalize(taskResult());

    expect(assertion).toMatchObject({ errored: true, passed: false });
    expect(assertion?.score).toBeUndefined();
    expect(assertion?.message).toContain("finite");
  });
});

describe("AssertionCollector labels", () => {
  it("exposes the label as the structured key next to the display name", async () => {
    const collector = new AssertionCollector();
    collector
      .recordValue({ name: "judge.boolean", severity: "soft", score: async () => ({ score: 0.4 }) })
      .label("citation");

    const [assertion] = await collector.finalize(taskResult());

    expect(assertion).toMatchObject({ name: "judge.boolean [citation]", key: "citation" });
  });

  it("leaves the key absent for unlabeled assertions", async () => {
    const collector = new AssertionCollector();
    collector.recordValue({
      name: "judge.boolean",
      severity: "soft",
      score: async () => ({ score: 1 }),
    });

    const [assertion] = await collector.finalize(taskResult());

    expect(assertion?.key).toBeUndefined();
  });
});
