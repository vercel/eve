import test from "node:test";
import assert from "node:assert/strict";
import { compareExperiment } from "./compare.mjs";

const plan = {
  experimentSha: "experiment",
  manifestHash: "hash",
  metricProfiles: [
    {
      id: "self-modification-v1",
      metricSchemaVersion: "self-modification-v1",
      primaryMetric: "creationElapsedMs",
    },
  ],
  repetitions: 2,
  variants: [
    { label: "baseline", sha: "a" },
    { label: "candidate", sha: "b" },
  ],
  fixtures: [
    { name: "agent-self-modification", metricProfile: "self-modification-v1", evals: ["create"] },
  ],
  matrix: [
    {
      fixture: "agent-self-modification",
      model: "openai-sol",
      modelId: "openai/model",
      blocks: [
        { repetition: 0, order: ["baseline", "candidate"] },
        { repetition: 1, order: ["candidate", "baseline"] },
      ],
    },
  ],
};
const sample = (variant, repetition, ms, verdict = "passed") => ({
  variant,
  fixture: "agent-self-modification",
  metricProfile: "self-modification-v1",
  eval: "create",
  model: "openai-sol",
  repetition,
  verdict,
  measurement: { status: "complete" },
  metrics: { creationElapsedMs: ms },
});

test("compares matched repetition blocks and retains expected missing samples", () => {
  const report = compareExperiment(plan, [
    sample("baseline", 0, 100),
    sample("candidate", 0, 80),
    sample("baseline", 1, 120),
  ]);
  assert.equal(report.complete, false);
  assert.equal(report.samples.length, 4);
  assert.equal(report.comparisons[0].matched, 1);
  assert.equal(report.comparisons[0].medianPairedDeltaMs, -20);
  assert.equal(report.aggregates[0].status, "complete");
});

test("does not compare failed correctness samples as latency wins", () => {
  const report = compareExperiment(plan, [
    sample("baseline", 0, 100),
    sample("candidate", 0, 1, "failed"),
  ]);
  assert.equal(report.comparisons[0].matched, 0);
  assert.equal(report.correctnessRegressions.length, 1);
  assert.equal(report.aggregates[0].status, "withheld");
});
