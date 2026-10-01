import test from "node:test";
import assert from "node:assert/strict";
import { compareExperiment, renderMarkdown } from "./compare.mjs";
import { renderPrSummary } from "./pr-summary.mjs";

const plan = {
  planHash: "hash",
  experimentRevision: "a".repeat(40),
  definitionPath: "experiments/example.mjs",
  analysis: {
    compare: { axis: "configuration", baseline: "base" },
    primaryMetric: "timing.elapsed",
  },
  sampling: { repetitions: 2 },
  sources: [{ label: "head", sha: "a".repeat(40) }],
  configurations: [
    { label: "base", settings: { selfModification: { model: "model/a" } } },
    { label: "new", settings: { selfModification: { model: "model/b" } } },
  ],
  fixtures: [{ name: "fixture", evals: ["one", "two"] }],
  measurementBundles: {
    timing: {
      metrics: {
        elapsed: { unit: "ms", direction: "lower" },
        calls: { unit: "count", direction: "neutral" },
      },
    },
  },
};
plan.schedule = plan.fixtures[0].evals.flatMap((evalId) =>
  [0, 1].flatMap((repetition) =>
    plan.configurations.map((configuration, executionOrder) => ({
      source: "head",
      configuration: configuration.label,
      fixture: "fixture",
      eval: evalId,
      repetition,
      executionOrder,
    })),
  ),
);
function row(cell) {
  const index = cell.configuration === "base" ? 0 : 1;
  return {
    ...cell,
    planHash: "hash",
    experimentRevision: plan.experimentRevision,
    sourceSha: "a".repeat(40),
    settings: plan.configurations[index].settings,
    execution: { status: "complete" },
    verdict: "passed",
    measurements: {
      "timing.elapsed": { status: "measured", value: index ? 13000 : 20000 },
      "timing.calls": { status: "measured", value: index ? 0 : 3 },
    },
  };
}
const url = "https://github.com/example/repo/actions/runs/123";
test("configuration overview uses model settings, medians, units, coverage and zero values", () => {
  const output = renderPrSummary(plan, compareExperiment(plan, plan.schedule.map(row)), {
    runUrl: url,
  });
  assert.match(output, /base \(model\/a\) \(baseline\)/);
  assert.match(output, /new \(model\/b\)/);
  assert.match(output, /20\.0s \(4\/4\)/);
  assert.match(output, /13\.0s \(4\/4\)/);
  assert.match(output, /0 \(4\/4\)/);
  assert.match(output, /Archived evidence \(14 days\)/);
});

test("USD metrics preserve sub-cent precision in summaries and paired deltas", () => {
  const costPlan = {
    ...plan,
    measurementBundles: { cost: { metrics: { child: { unit: "USD", direction: "lower" } } } },
    analysis: { ...plan.analysis, primaryMetric: "cost.child" },
  };
  const rows = plan.schedule.map((cell) => ({
    ...row(cell),
    measurements: {
      "cost.child": { status: "measured", value: cell.configuration === "base" ? 0.0058 : 0 },
    },
  }));
  const report = compareExperiment(costPlan, rows);
  const output = renderPrSummary(costPlan, report, { runUrl: url });
  assert.match(output, /\$0\.0058 \(4\/4\)/);
  assert.match(output, /\$0\.0000 \(4\/4\)/);
  assert.match(renderMarkdown(report), /-0\.0058/);
});

test("missing evidence and failed correctness are not treated as measured zero", () => {
  const rows = plan.schedule
    .map(row)
    .filter((cell) => !(cell.eval === "two" && cell.configuration === "new"));
  rows.find((cell) => cell.eval === "one" && cell.configuration === "new").verdict = "failed";
  const output = renderPrSummary(plan, compareExperiment(plan, rows), { runUrl: url });
  assert.match(output, /Results are incomplete/);
  assert.match(output, /Correctness regression/);
  assert.match(output, /1\/4/);
  assert.match(output, /0\/2 paired/);
});

test("unavailable and not-applicable metrics have separate coverage, not fabricated zeros", () => {
  const rows = plan.schedule.map(row);
  for (const cell of rows.filter((cell) => cell.configuration === "new")) {
    cell.measurements["timing.calls"] = {
      status: cell.eval === "one" ? "not-applicable" : "unavailable",
      reason: "no capture",
    };
  }
  const output = renderPrSummary(plan, compareExperiment(plan, rows), { runUrl: url });
  assert.match(output, /new \(model\/b\) \| 4\/4 \| 13\.0s \(4\/4\) \| — \(0\/4\)/);
});

test("source comparison separates fixed configurations and escapes labels", () => {
  const sourcePlan = {
    ...plan,
    analysis: { ...plan.analysis, compare: { axis: "source", baseline: "head" } },
    sources: [...plan.sources, { label: "new|source", sha: "b".repeat(40) }],
    configurations: [
      { label: "base", settings: {} },
      { label: "other", settings: {} },
    ],
  };
  sourcePlan.schedule = sourcePlan.configurations.flatMap((config) =>
    sourcePlan.sources.flatMap((source, executionOrder) => ({
      source: source.label,
      configuration: config.label,
      fixture: "fixture",
      eval: "one",
      repetition: 0,
      executionOrder,
    })),
  );
  sourcePlan.sampling = { repetitions: 1 };
  sourcePlan.fixtures = [{ name: "fixture", evals: ["one"] }];
  const rows = sourcePlan.schedule.map((cell) => ({
    ...cell,
    planHash: "hash",
    experimentRevision: plan.experimentRevision,
    sourceSha: sourcePlan.sources.find((item) => item.label === cell.source).sha,
    settings: {},
    execution: { status: "complete" },
    verdict: "passed",
    measurements: {
      "timing.elapsed": { status: "measured", value: 100 },
      "timing.calls": { status: "measured", value: 0 },
    },
  }));
  const output = renderPrSummary(sourcePlan, compareExperiment(sourcePlan, rows), { runUrl: url });
  assert.match(output, /Fixed configuration: base/);
  assert.match(output, /Fixed configuration: other/);
  assert.match(output, /new\\\|source/);
});
