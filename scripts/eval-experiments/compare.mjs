import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function compareExperiment(plan, samples) {
  const expected = [];
  for (const schedule of plan.matrix)
    for (const block of schedule.blocks)
      for (const label of block.order) {
        const variant = plan.variants.find((item) => item.label === label);
        const fixture = plan.fixtures.find((item) => item.name === schedule.fixture);
        for (const evalId of fixture.evals)
          expected.push({
            variant: label,
            sha: variant.sha,
            fixture: fixture.name,
            eval: evalId,
            model: schedule.model,
            modelId: schedule.modelId,
            repetition: block.repetition,
            executionOrder: block.order.indexOf(label),
          });
      }
  const indexed = new Map(samples.map((sample) => [key(sample), sample]));
  const rows = expected.map(
    (identity) =>
      indexed.get(key(identity)) ?? {
        ...identity,
        verdict: "missing",
        measurement: { status: "incomplete", reason: "missing-sample" },
      },
  );
  const comparisons = [];
  const aggregateGroups = new Map();
  for (const schedule of plan.matrix) {
    const fixture = plan.fixtures.find((item) => item.name === schedule.fixture);
    for (const evalId of fixture.evals) {
      const baseline = plan.variants[0];
      for (const variant of plan.variants.slice(1)) {
        const baselineRows = rows.filter(
          (r) =>
            r.fixture === schedule.fixture &&
            r.eval === evalId &&
            r.model === schedule.model &&
            r.variant === baseline.label,
        );
        const candidateRows = rows.filter(
          (r) =>
            r.fixture === schedule.fixture &&
            r.eval === evalId &&
            r.model === schedule.model &&
            r.variant === variant.label,
        );
        const byRepetition = new Map(baselineRows.map((row) => [row.repetition, row]));
        const pairs = candidateRows
          .map((candidate) => [byRepetition.get(candidate.repetition), candidate])
          .filter(([b, c]) => b && c);
        const matched = pairs.filter(
          ([b, c]) =>
            b.verdict === "passed" &&
            c.verdict === "passed" &&
            b.measurement?.status === "complete" &&
            c.measurement?.status === "complete",
        );
        const deltas = matched.map(
          ([b, c]) => c.metrics.creationElapsedMs - b.metrics.creationElapsedMs,
        );
        const ratios = matched
          .map(([b, c]) => c.metrics.creationElapsedMs / b.metrics.creationElapsedMs)
          .filter((ratio) => Number.isFinite(ratio) && ratio > 0);
        const excludedCount = plan.repetitions - matched.length;
        const comparison = {
          fixture: schedule.fixture,
          eval: evalId,
          model: schedule.model,
          modelId: schedule.modelId,
          baseline: baseline.label,
          candidate: variant.label,
          baselineCorrect: baselineRows.filter((r) => r.verdict === "passed").length,
          candidateCorrect: candidateRows.filter((r) => r.verdict === "passed").length,
          baselineFailures: baselineRows.filter((r) => r.verdict === "failed").length,
          baselineSkipped: baselineRows.filter((r) => r.verdict === "skipped").length,
          baselineTimeouts: baselineRows.filter((r) => r.timedOut).length,
          baselineInfrastructureErrors: baselineRows.filter((r) => r.infrastructureError).length,
          planned: plan.repetitions,
          failures: candidateRows.filter((r) => r.verdict === "failed").length,
          skipped: candidateRows.filter((r) => r.verdict === "skipped").length,
          infrastructureErrors: candidateRows.filter((r) => r.infrastructureError).length,
          timeouts: candidateRows.filter((r) => r.timedOut).length,
          missingMetrics: candidateRows.filter((r) => r.measurement?.status !== "complete").length,
          missingSamples: candidateRows.filter((r) => r.verdict === "missing").length,
          matched: matched.length,
          excluded: excludedCount,
          samplePairs: pairs.map(([b, c]) => ({
            repetition: c.repetition,
            baselineVerdict: b.verdict,
            candidateVerdict: c.verdict,
            baselineMeasurement: b.measurement?.status,
            candidateMeasurement: c.measurement?.status,
          })),
          correctCount: {
            baseline: baselineRows.filter((r) => r.verdict === "passed").length,
            candidate: candidateRows.filter((r) => r.verdict === "passed").length,
          },
          baselineMedianMs: median(matched.map(([b]) => b.metrics.creationElapsedMs)),
          candidateMedianMs: median(matched.map(([, c]) => c.metrics.creationElapsedMs)),
          medianPairedDeltaMs: median(deltas),
          geometricMeanRatio: geometricMean(ratios),
        };
        comparisons.push(comparison);
        const aggregateKey = `${schedule.model}:${variant.label}`;
        const aggregate = aggregateGroups.get(aggregateKey) ?? [];
        aggregate.push(comparison);
        aggregateGroups.set(aggregateKey, aggregate);
      }
    }
  }
  const aggregates = [...aggregateGroups.entries()].map(([groupKey, items]) => {
    const [model, candidate] = groupKey.split(":");
    const missing = items.some((item) => item.geometricMeanRatio === null);
    return {
      model,
      candidate,
      status: missing ? "withheld" : "complete",
      reason: missing ? "one or more selected evals has no matched complete samples" : undefined,
      equalWeightGeometricMeanRatio: missing
        ? null
        : geometricMean(items.map((item) => item.geometricMeanRatio)),
    };
  });
  return {
    version: 1,
    experimentSha: plan.experimentSha,
    manifestHash: plan.manifestHash,
    metricSchemaVersion: plan.metricSchemaVersion,
    diffs: plan.diffs,
    complete: rows.every(
      (row) => row.verdict !== "missing" && row.verdict !== "unknown" && !row.infrastructureError,
    ),
    correctnessRegressions: comparisons.filter(
      (item) => item.candidateCorrect < item.baselineCorrect,
    ),
    allComparisonsPassCorrectness: comparisons.every(
      (item) => item.candidateCorrect === item.planned && item.baselineCorrect === item.planned,
    ),
    aggregates,
    comparisons,
    samples: rows,
  };
}

export function renderMarkdown(report) {
  const lines = [
    "## Eval latency experiment",
    "",
    `**Completeness:** ${report.complete ? "complete" : "INCOMPLETE — expected samples are missing"}`,
    `**Correctness regressions:** ${report.correctnessRegressions.length}`,
    `**All strict evals passed:** ${report.allComparisonsPassCorrectness ? "yes" : "no"}`,
    "",
    "| Fixture / eval | Model | Candidate | Correctness | Matched | Median paired Δ (ms) | Geomean ratio |",
    "|---|---|---:|---:|---:|---:|---:|",
  ];
  for (const row of report.comparisons)
    lines.push(
      `| ${row.fixture} / ${row.eval} | ${row.model} | ${row.candidate} | ${row.candidateCorrect}/${row.planned} (baseline ${row.baselineCorrect}/${row.planned}) | ${row.matched} | ${format(row.medianPairedDeltaMs)} | ${format(row.geometricMeanRatio)} |`,
    );
  lines.push(
    "",
    "### Full-suite aggregates",
    "",
    "| Model | Candidate | Equal-weight geomean ratio | Status |",
    "|---|---|---:|---|",
  );
  for (const aggregate of report.aggregates ?? [])
    lines.push(
      `| ${aggregate.model} | ${aggregate.candidate} | ${format(aggregate.equalWeightGeometricMeanRatio)} | ${aggregate.status} |`,
    );
  lines.push(
    "",
    "Latency includes only matched repetition blocks where both variants passed strict correctness and have complete measurements. This conditional comparison does not establish preserved quality.",
  );
  return `${lines.join("\n")}\n`;
}
function key(row) {
  return [row.variant, row.fixture, row.eval, row.model, row.repetition].join("\u0000");
}
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function geometricMean(values) {
  return values.length
    ? Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length)
    : null;
}
function format(value) {
  return value === null ? "—" : Number(value).toFixed(2);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [planPath, samplesPath, outputPath, markdownPath] = process.argv.slice(2);
  if (!planPath || !samplesPath || !outputPath)
    throw new Error("Usage: node compare.mjs <plan.json> <samples.json> <report.json> [report.md]");
  const report = compareExperiment(
    JSON.parse(await readFile(planPath, "utf8")),
    JSON.parse(await readFile(samplesPath, "utf8")),
  );
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  if (markdownPath) await writeFile(markdownPath, renderMarkdown(report));
  console.log(renderMarkdown(report));
  if (!report.complete) process.exitCode = 1;
}
