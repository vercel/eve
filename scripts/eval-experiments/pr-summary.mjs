import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_LENGTH = 55_000;
const MAX_NOTES = 5;

function escapeCell(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "\\|")
    .replaceAll("`", "&#96;")
    .replaceAll("*", "&#42;")
    .replaceAll("_", "&#95;")
    .replaceAll("[", "&#91;")
    .replaceAll("]", "&#93;")
    .replaceAll("\n", " ")
    .replaceAll("\r", " ");
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function display(value, unit) {
  if (value === null || !Number.isFinite(value)) return "—";
  if (unit === "ms") return `${(value / 1000).toFixed(1)}s`;
  if (unit === "USD") return `$${value.toFixed(4)}`;
  return `${Number(value.toFixed(1))}${unit === "count" ? "" : ` ${escapeCell(unit)}`}`;
}

function settingsLabel(settings) {
  const parts = Object.entries(settings ?? {}).flatMap(([scope, fields]) =>
    Object.entries(fields).map(([key, value]) => `${scope}.${key}=${value}`),
  );
  return parts.length ? parts.join(", ") : "fixture defaults";
}

function isEditingModelMatrix(plan) {
  const [first] = plan.configurations;
  if (!first?.settings?.selfModification?.model) return false;
  const withoutModel = (settings) =>
    JSON.stringify({
      ...settings,
      selfModification: { ...settings.selfModification, model: undefined },
    });
  return plan.configurations.every(
    (entry) =>
      entry.settings?.selfModification?.model &&
      withoutModel(entry.settings) === withoutModel(first.settings),
  );
}

function entryLabel(entry, axis, plan) {
  if (axis === "source") return `${entry.label} (${entry.sha.slice(0, 7)})`;
  const settings = entry.settings ?? {};
  const scope = settings.selfModification;
  return isEditingModelMatrix(plan)
    ? `${entry.label} (${scope.model}${scope.reasoning ? `, ${scope.reasoning}` : ""})`
    : `${entry.label} (${settingsLabel(settings)})`;
}

function metricList(plan) {
  return Object.entries(plan.measurementBundles).flatMap(([namespace, bundle]) =>
    Object.entries(bundle.metrics).map(([name, metadata]) => ({
      name: `${namespace}.${name}`,
      ...metadata,
    })),
  );
}

function table(plan, report, fixed, metrics) {
  const axis = plan.analysis.compare.axis;
  const entries = axis === "source" ? plan.sources : plan.configurations;
  const fixedAxis = axis === "source" ? "configuration" : "source";
  const total =
    plan.fixtures.reduce((sum, fixture) => sum + fixture.evals.length, 0) *
    plan.sampling.repetitions;
  const heading =
    axis === "source" ? "Source" : isEditingModelMatrix(plan) ? "Editing model" : "Configuration";
  const lines = [
    `| ${heading} | Evals passed${metrics.map((metric) => ` | ${escapeCell(metric.name)} (median, n)`).join("")} |`,
    `|---|---:${metrics.map(() => "|---:").join("")}|`,
  ];
  for (const entry of entries) {
    const rows = report.samples.filter(
      (row) => row[axis] === entry.label && row[fixedAxis] === fixed.label,
    );
    const correct = rows.filter((row) => row.verdict === "passed").length;
    const values = metrics.map((metric) => {
      const measured = rows
        .filter((row) => row.verdict === "passed" && row.execution?.status === "complete")
        .map((row) => row.measurements?.[metric.name])
        .filter(
          (measurement) => measurement?.status === "measured" && Number.isFinite(measurement.value),
        )
        .map((measurement) => measurement.value);
      return `${display(median(measured), metric.unit)} (${measured.length}/${total})`;
    });
    const label =
      entry.label === plan.analysis.compare.baseline
        ? `**${escapeCell(entryLabel(entry, axis, plan))} (baseline)**`
        : escapeCell(entryLabel(entry, axis, plan));
    lines.push(
      `| ${label} | ${correct}/${total}${values.map((value) => ` | ${value}`).join("")} |`,
    );
  }
  return lines.join("\n");
}

function notableComparisons(plan, report) {
  const primary = plan.analysis.primaryMetric;
  const ranked = report.comparisons
    .map((comparison) => {
      const metric = comparison.metrics[primary];
      const regression = comparison.candidateCorrect < comparison.baselineCorrect;
      const relative =
        metric?.baselineMedian > 0 && metric.candidateMedian !== null
          ? Math.abs(metric.candidateMedian - metric.baselineMedian) / metric.baselineMedian
          : 0;
      return { comparison, metric, regression, relative };
    })
    .filter(
      ({ comparison, metric, regression, relative }) =>
        regression ||
        (metric && metric.paired >= 2 && relative >= 0.25) ||
        (metric && metric.paired < comparison.planned && metric.paired < 2),
    );
  ranked.sort(
    (a, b) =>
      Number(b.regression) - Number(a.regression) ||
      b.relative - a.relative ||
      `${a.comparison.fixture}/${a.comparison.eval}/${a.comparison.fixed}/${a.comparison.candidate}`.localeCompare(
        `${b.comparison.fixture}/${b.comparison.eval}/${b.comparison.fixed}/${b.comparison.candidate}`,
      ),
  );
  const lines = ranked.slice(0, MAX_NOTES).map(({ comparison, metric, regression }) => {
    const label = `${comparison.fixture}/${comparison.eval}: ${comparison.candidate} vs ${comparison.baseline} (fixed: ${comparison.fixed})`;
    const detail = metric
      ? `${escapeCell(primary)} ${display(metric.baselineMedian, metric.unit)} → ${display(metric.candidateMedian, metric.unit)}; ${metric.paired}/${comparison.planned} paired`
      : "no primary metric";
    return `- ${regression ? "Correctness regression: " : ""}${escapeCell(label)} — ${comparison.candidateCorrect}/${comparison.planned} vs ${comparison.baselineCorrect}/${comparison.planned} passed; ${detail}.`;
  });
  if (ranked.length > MAX_NOTES)
    lines.push(`- ${ranked.length - MAX_NOTES} more cuts in the full report.`);
  return lines;
}

export function renderPrSummary(plan, report, { runUrl = "", artifactUrl = runUrl } = {}) {
  if (plan.planHash !== report.planHash) throw new Error("Summary plan/report hashes differ.");
  if (report.samples.length !== plan.schedule.length)
    throw new Error("Summary report does not cover the planned schedule.");
  const axis = plan.analysis.compare.axis;
  const fixedEntries = axis === "source" ? plan.configurations : plan.sources;
  const metrics = metricList(plan);
  const complete = report.executionComplete && report.analysisComplete;
  const lines = [
    "## Eval experiment results",
    "",
    `Definition: \`${escapeCell(plan.definitionPath)}\` · Revision: \`${escapeCell(plan.experimentRevision)}\` · Plan: \`${escapeCell(plan.planHash.slice(0, 12))}\``,
    `Execution: **${report.completeness.executionComplete}/${report.completeness.planned} complete**, ${report.completeness.executionErrors} errors, ${report.completeness.missingExecutions} missing. Analysis: **${report.analysisComplete ? "complete" : "incomplete"}** (${report.completeness.analysisErrors} errors).`,
    `Correctness regressions: **${report.correctnessRegressions.length}** (per eval comparison).`,
    "",
  ];
  if (!complete)
    lines.push(
      "⚠️ Results are incomplete; do not treat apparent performance differences as wins.",
      "",
    );
  for (const fixed of fixedEntries) {
    if (fixedEntries.length > 1)
      lines.push(
        `### Fixed ${axis === "source" ? "configuration" : "source"}: ${escapeCell(entryLabel(fixed, axis === "source" ? "configuration" : "source", plan))}`,
        "",
      );
    for (let start = 0; start < metrics.length; start += 3) {
      lines.push(table(plan, report, fixed, metrics.slice(start, start + 3)), "");
    }
  }
  lines.push(
    "Medians are descriptive across measured, healthy, passing invocations (equal weight per invocation); **n/planned** shows coverage per metric. Milliseconds are displayed as seconds. These pooled medians are not paired comparisons or significance tests. Correctness counts use all planned invocations; consult the full report for per-eval paired-correct deltas and exclusions.",
    "",
  );
  const notes = notableComparisons(plan, report);
  if (notes.length) lines.push("### Per-eval cuts", "", ...notes, "");
  lines.push(
    `[Full run and report](${runUrl}) · [Archived evidence (14 days)](${artifactUrl})`,
    "",
  );
  const output = lines.join("\n");
  if (output.length > MAX_LENGTH)
    return `${lines.slice(0, 6).join("\n")}\n\nThe matrix is too large for a PR comment. See the full run and archived report: ${runUrl}\n`;
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [planPath, reportPath, outputPath, runUrl] = process.argv.slice(2);
  if (!planPath || !reportPath || !outputPath || !runUrl)
    throw new Error("Usage: node pr-summary.mjs <plan.json> <report.json> <output.md> <run-url>");
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const artifactUrl = `${runUrl}#artifacts`;
  await writeFile(outputPath, renderPrSummary(plan, report, { runUrl, artifactUrl }));
}
