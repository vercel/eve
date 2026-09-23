import test from "node:test";
import assert from "node:assert/strict";
import { compareExperiment } from "./compare.mjs";

const plan = {
  planHash: "hash",
  experimentRevision: "revision",
  analysis: { compare: { axis: "source", baseline: "base" }, primaryMetric: "elapsed" },
  sampling: { repetitions: 2 },
  sources: [
    { label: "base", sha: "a" },
    { label: "candidate", sha: "b" },
  ],
  configurations: [{ label: "config", settings: {} }],
  fixtures: [{ name: "fixture", evals: ["case"] }],
  measurementBundles: {
    timing: {
      metrics: {
        elapsed: { unit: "ms", direction: "lower" },
        count: { unit: "count", direction: "neutral" },
      },
    },
  },
  schedule: [0, 1].flatMap((repetition) =>
    ["base", "candidate"].map((source, executionOrder) => ({
      source,
      configuration: "config",
      fixture: "fixture",
      eval: "case",
      repetition,
      executionOrder,
    })),
  ),
};
const sample = (source, repetition, executionOrder, elapsed, verdict = "passed") => ({
  planHash: "hash",
  experimentRevision: "revision",
  source,
  sourceSha: source === "base" ? "a" : "b",
  configuration: "config",
  settings: {},
  fixture: "fixture",
  eval: "case",
  repetition,
  executionOrder,
  execution: { status: "complete" },
  verdict,
  measurements: {
    "timing.elapsed": { status: "measured", value: elapsed },
    "timing.count": { status: "measured", value: 0 },
  },
});

test("pairs by provenance, preserves zero metrics and units, and keeps comparisons per metric", () => {
  const report = compareExperiment(plan, [
    sample("base", 0, 0, 100),
    sample("candidate", 0, 1, 80),
    sample("base", 1, 0, 120),
    sample("candidate", 1, 1, 90),
  ]);
  assert.equal(report.comparisons[0].metrics["timing.elapsed"].paired, 2);
  assert.equal(report.comparisons[0].metrics["timing.count"].baselineMedian, 0);
  assert.equal(report.comparisons[0].metrics["timing.count"].positiveValueRatios.length, 0);
  assert.equal(report.comparisons[0].metrics["timing.elapsed"].unit, "ms");
  assert.equal(report.samples.length, 4);
});

test("compares configurations while holding each source fixed", () => {
  const configurationPlan = {
    ...plan,
    analysis: {
      compare: { axis: "configuration", baseline: "config-a" },
      primaryMetric: "timing.elapsed",
    },
    configurations: [
      { label: "config-a", settings: {} },
      { label: "config-b", settings: {} },
    ],
    schedule: [0].flatMap((repetition) =>
      ["base", "candidate"].flatMap((source) =>
        ["config-a", "config-b"].map((configuration, executionOrder) => ({
          source,
          configuration,
          fixture: "fixture",
          eval: "case",
          repetition,
          executionOrder,
        })),
      ),
    ),
  };
  const rows = configurationPlan.schedule.map((cell) => ({
    planHash: "hash",
    experimentRevision: "revision",
    source: cell.source,
    sourceSha: cell.source === "base" ? "a" : "b",
    configuration: cell.configuration,
    settings: {},
    fixture: cell.fixture,
    eval: cell.eval,
    repetition: cell.repetition,
    executionOrder: cell.executionOrder,
    execution: { status: "complete" },
    verdict: "passed",
    measurements: {
      "timing.elapsed": { status: "measured", value: cell.configuration === "config-a" ? 100 : 80 },
      "timing.count": { status: "measured", value: 0 },
    },
  }));
  const report = compareExperiment(configurationPlan, rows);
  assert.equal(report.comparisons.length, 2);
  assert.ok(
    report.comparisons.every(
      (item) =>
        (item.axis === "configuration" && item.fixed === "base") || item.fixed === "candidate",
    ),
  );
  assert.ok(
    report.comparisons.every((item) => item.metrics["timing.elapsed"].medianPairedDelta === -20),
  );
});

test("detects duplicate and mismatched samples and excludes failed correctness", () => {
  const wrong = { ...sample("candidate", 0, 1, 1, "failed"), sourceSha: "wrong" };
  const valid = sample("candidate", 0, 1, 90);
  const report = compareExperiment(plan, [sample("base", 0, 0, 100), wrong, valid, valid]);
  assert.equal(report.completeness.duplicateSamples, 1);
  assert.equal(report.completeness.provenanceMismatches, 1);
  assert.equal(report.comparisons[0].metrics["timing.elapsed"].paired, 1);
});
