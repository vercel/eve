import type { EveCodeDatasetResults, EveCodeHarnessScore } from "./eve-code-results";

/** Ranks by resolve rate, then by median latency, matching eve-bench's correctness-first order. */
export function rankedHarnesses(results: EveCodeDatasetResults): EveCodeHarnessScore[] {
  return [...results.harnesses].sort(
    (left, right) =>
      right.resolveRate.estimate - left.resolveRate.estimate ||
      left.latencyP50Ms - right.latencyP50Ms,
  );
}

export function renderBenchmarkMarkdown(
  results: EveCodeDatasetResults | undefined,
  dataset: string,
): string {
  if (!results) return `No published ${dataset} results yet.`;
  const pct = (value: number) => `${Math.round(value * 100)}%`;
  const rows = rankedHarnesses(results).map(
    (h) =>
      `| \`${h.harness}\` | ${pct(h.resolveRate.estimate)} (${h.resolved}/${h.attempts}) | ${pct(h.resolveRate.low)}–${pct(h.resolveRate.high)} | ${(h.latencyP50Ms / 1000).toFixed(1)}s | ${(h.latencyP90Ms / 1000).toFixed(1)}s | ${h.measuredAt?.slice(0, 10) ?? "—"} |`,
  );
  return [
    `${results.tasks} tasks × ${results.attempts} attempts on \`${results.model.id}\`. Snapshot updated ${results.generatedAt.slice(0, 10)}.`,
    "",
    "| Harness | Resolved | 95% interval | Median latency | p90 latency | Measured |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}
