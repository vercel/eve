import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function compareExperiment(plan, extracted) {
  const samples = Array.isArray(extracted) ? extracted : extracted.samples;
  const analysisErrors = Array.isArray(extracted) ? [] : (extracted.analysisErrors ?? []);
  const duplicates = [];
  const unexpected = [];
  const provenanceMismatches = [];
  const indexed = new Map();
  for (const sample of samples) {
    const key = identityKey(sample);
    const cell = plan.schedule.find((entry) => identityMatches(entry, sample));
    if (!cell) {
      unexpected.push(sample);
      continue;
    }
    const expectedIdentity = rowIdentity(plan, cell);
    if (!sameProvenance(expectedIdentity, sample)) {
      provenanceMismatches.push({ expected: expectedIdentity, actual: sample });
      continue;
    }
    if (indexed.has(key)) {
      duplicates.push(sample);
      continue;
    }
    indexed.set(key, sample);
  }
  const rows = plan.schedule.map((cell) => {
    const identity = rowIdentity(plan, cell);
    return (
      indexed.get(identityKey(identity)) ?? {
        ...identity,
        execution: { status: "missing" },
        verdict: "missing",
        measurements: {},
      }
    );
  });
  const axis = plan.analysis.compare.axis;
  const comparedEntries = axis === "source" ? plan.sources : plan.configurations;
  const fixedEntries = axis === "source" ? plan.configurations : plan.sources;
  const baseline = plan.analysis.compare.baseline;
  const comparisons = [];
  for (const fixed of fixedEntries)
    for (const candidate of comparedEntries.filter((item) => item.label !== baseline)) {
      const baselineLabel = baseline;
      for (const fixture of plan.fixtures)
        for (const evalId of fixture.evals) {
          const baselineRows = rows.filter(
            (row) =>
              row.fixture === fixture.name &&
              row.eval === evalId &&
              row[axis] === baselineLabel &&
              row[axis === "source" ? "configuration" : "source"] === fixed.label,
          );
          const candidateRows = rows.filter(
            (row) =>
              row.fixture === fixture.name &&
              row.eval === evalId &&
              row[axis] === candidate.label &&
              row[axis === "source" ? "configuration" : "source"] === fixed.label,
          );
          const baselineByRep = new Map(baselineRows.map((row) => [row.repetition, row]));
          const pairs = candidateRows
            .map((row) => [baselineByRep.get(row.repetition), row])
            .filter(([left, right]) => left && right);
          const correctnessPairCount = pairs.filter(
            ([left, right]) => left.verdict === "passed" && right.verdict === "passed",
          ).length;
          const metrics = Object.entries(plan.measurementBundles).flatMap(([namespace, bundle]) =>
            Object.entries(bundle.metrics).map(([name, metadata]) => ({
              name: `${namespace}.${name}`,
              ...metadata,
            })),
          );
          const metricComparisons = {};
          for (const metric of metrics) {
            const matched = pairs.filter(
              ([left, right]) =>
                left.verdict === "passed" &&
                right.verdict === "passed" &&
                left.execution?.status === "complete" &&
                right.execution?.status === "complete" &&
                left.measurements?.[metric.name]?.status === "measured" &&
                right.measurements?.[metric.name]?.status === "measured",
            );
            const leftValues = matched.map(([left]) => left.measurements[metric.name].value);
            const rightValues = matched.map(([, right]) => right.measurements[metric.name].value);
            const deltas = matched.map(
              ([left, right]) =>
                right.measurements[metric.name].value - left.measurements[metric.name].value,
            );
            const ratios = matched
              .map(([left, right]) => {
                const denominator = left.measurements[metric.name].value;
                return denominator === 0
                  ? null
                  : right.measurements[metric.name].value / denominator;
              })
              .filter((ratio) => ratio !== null && Number.isFinite(ratio) && ratio > 0);
            metricComparisons[metric.name] = {
              unit: metric.unit,
              direction: metric.direction,
              baselineMedian: median(leftValues),
              candidateMedian: median(rightValues),
              medianPairedDelta: median(deltas),
              positiveValueRatios: ratios,
              paired: matched.length,
              excluded: plan.sampling.repetitions - matched.length,
              pairs: pairs.map(([left, right]) => ({
                repetition: right.repetition,
                baselineVerdict: left.verdict,
                candidateVerdict: right.verdict,
                baselineStatus: left.measurements?.[metric.name]?.status ?? "missing",
                candidateStatus: right.measurements?.[metric.name]?.status ?? "missing",
              })),
            };
          }
          comparisons.push({
            fixture: fixture.name,
            eval: evalId,
            axis,
            fixed: fixed.label,
            baseline: baselineLabel,
            candidate: candidate.label,
            primaryMetric: plan.analysis.primaryMetric,
            baselineCorrect: baselineRows.filter((row) => row.verdict === "passed").length,
            candidateCorrect: candidateRows.filter((row) => row.verdict === "passed").length,
            correctnessPaired: correctnessPairCount,
            planned: plan.sampling.repetitions,
            executionErrors: [...baselineRows, ...candidateRows].filter(
              (row) => row.execution?.status === "error",
            ).length,
            metrics: metricComparisons,
          });
        }
    }
  const completeness = {
    planned: rows.length,
    executionComplete: rows.filter((row) => row.execution?.status === "complete").length,
    executionErrors: rows.filter((row) => row.execution?.status === "error").length,
    missingExecutions: rows.filter((row) => row.execution?.status === "missing").length,
    analysisErrors: analysisErrors.length,
    unexpectedSamples: unexpected.length,
    duplicateSamples: duplicates.length,
    provenanceMismatches: provenanceMismatches.length,
  };
  return {
    version: 2,
    planHash: plan.planHash,
    experimentRevision: plan.experimentRevision,
    analysisRevision: extracted.analysisRevision ?? plan.implementationRevision,
    metricBundles: plan.measurementBundles,
    diffs: plan.diffs,
    completeness,
    executionComplete: completeness.missingExecutions === 0 && completeness.executionErrors === 0,
    analysisComplete:
      analysisErrors.length === 0 &&
      unexpected.length === 0 &&
      duplicates.length === 0 &&
      provenanceMismatches.length === 0,
    correctnessRegressions: comparisons.filter(
      (item) => item.candidateCorrect < item.baselineCorrect,
    ),
    comparisons,
    analysisErrors,
    unexpectedSamples: unexpected,
    duplicateSamples: duplicates,
    provenanceMismatches,
    samples: rows,
  };
}

export function renderMarkdown(report) {
  const lines = [
    "## Eval experiment",
    "",
    `**Execution:** ${report.completeness.executionComplete ? "complete" : "incomplete"} (${report.completeness.executionComplete}/${report.completeness.planned})`,
    `**Analysis:** ${report.analysisComplete ? "complete" : "errors"} (${report.completeness.analysisErrors} errors)`,
    `**Correctness regressions:** ${report.correctnessRegressions.length}`,
    "",
    "| Fixture / eval | Compared axis | Fixed entry | Candidate | Metric | Unit | Correctness | Paired | Median delta |",
    "|---|---|---|---|---|---|---:|---:|---:|",
  ];
  for (const row of report.comparisons)
    for (const [name, metric] of Object.entries(row.metrics)) {
      lines.push(
        `| ${row.fixture} / ${row.eval} | ${row.axis} | ${row.fixed} | ${row.candidate} | ${name} | ${metric.unit} | ${row.candidateCorrect}/${row.planned} (baseline ${row.baselineCorrect}/${row.planned}) | ${metric.paired} | ${format(metric.medianPairedDelta)} |`,
      );
    }
  lines.push(
    "",
    "Measurements are derived from archived evidence. Paired values include only healthy executions where both evals passed and the metric was measured. A correctness regression is not a performance win.",
  );
  return `${lines.join("\n")}\n`;
}
function rowIdentity(plan, cell) {
  return {
    planHash: plan.planHash,
    experimentRevision: plan.experimentRevision,
    source: cell.source,
    sourceSha: plan.sources.find((item) => item.label === cell.source)?.sha,
    configuration: cell.configuration,
    settings: plan.configurations.find((item) => item.label === cell.configuration)?.settings,
    fixture: cell.fixture,
    eval: cell.eval,
    repetition: cell.repetition,
    executionOrder: cell.executionOrder,
  };
}
function identityKey(row) {
  return [row.source, row.configuration, row.fixture, row.eval, row.repetition].join("\0");
}
function identityMatches(cell, row) {
  return (
    cell.source === row.source &&
    cell.configuration === row.configuration &&
    cell.fixture === row.fixture &&
    cell.eval === row.eval &&
    cell.repetition === row.repetition &&
    cell.executionOrder === row.executionOrder
  );
}
function sameProvenance(expected, actual) {
  return (
    [
      "planHash",
      "experimentRevision",
      "source",
      "sourceSha",
      "configuration",
      "fixture",
      "eval",
      "repetition",
      "executionOrder",
    ].every((key) => actual[key] === expected[key]) &&
    JSON.stringify(actual.settings) === JSON.stringify(expected.settings)
  );
}
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
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
  if (!report.executionComplete || !report.analysisComplete) process.exitCode = 1;
}
