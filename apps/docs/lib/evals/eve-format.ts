import {
  orderedModels,
  type EveDatasetResults,
  type EveHarnessScore,
  type EveModelResults,
} from "./eve-results";
import type { BenchmarkRow } from "./results";

const FAMILY_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
};

/** Ranks by resolve rate, then by median latency, matching eve-bench's correctness-first order. */
export function rankedHarnesses(results: EveModelResults): EveHarnessScore[] {
  return [...results.harnesses].sort(
    (left, right) =>
      right.resolveRate.estimate - left.resolveRate.estimate ||
      left.latencyP50Ms - right.latencyP50Ms,
  );
}

export function modelFamilyLabel(family: string): string {
  return FAMILY_LABELS[family.toLowerCase()] ?? family;
}

export function modelShortName(modelId: string): string {
  return modelId.split("/").at(-1) ?? modelId;
}

export function formatDurationMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  const totalSeconds = ms / 1000;
  if (totalSeconds < 10) return `${totalSeconds.toFixed(1)}s`;
  const roundedSeconds = Math.round(totalSeconds);
  const minutes = Math.floor(roundedSeconds / 60);
  const seconds = roundedSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

export function formatTokens(tokens: number | null): string {
  if (tokens === null || !Number.isFinite(tokens)) return "—";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 10_000) return `${Math.round(tokens / 1_000)}K`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(Math.round(tokens));
}

export function formatPercent(rate: number | null, decimals = 0): string {
  if (rate === null || !Number.isFinite(rate)) return "—";
  return `${(rate * 100).toFixed(decimals)}%`;
}

export function formatUsd(amount: number | null): string {
  if (amount === null || !Number.isFinite(amount)) return "—";
  return `$${amount.toFixed(2)}`;
}

export function formatMedianCount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function renderModelMarkdown(
  dataset: EveDatasetResults,
  modelResults: EveModelResults,
): string {
  const rows = rankedHarnesses(modelResults).map((h) => {
    const label = h.version ? `\`${h.harness}@${h.version}\`` : `\`${h.harness}\``;
    const resolved = `${formatPercent(h.resolveRate.estimate)} (${h.resolved}/${h.attempts})`;
    const ci = `${formatPercent(h.resolveRate.low)}–${formatPercent(h.resolveRate.high)}`;
    const passAll = formatPercent(h.passAllRate);
    const latency = `${formatDurationMs(h.latencyP50Ms)} / ${formatDurationMs(h.latencyP90Ms)}`;
    const tokens = `${formatTokens(h.inputTokens)} / ${formatTokens(h.outputTokens)}`;
    const cache = formatPercent(h.cachedShare, 1);
    const stepOne = formatTokens(h.overhead?.firstStepInputTokens ?? null);
    const stepsTools =
      h.overhead?.modelStepsMedian != null || h.overhead?.toolCallsMedian != null
        ? `${formatMedianCount(h.overhead?.modelStepsMedian ?? null)} / ${formatMedianCount(h.overhead?.toolCallsMedian ?? null)}`
        : "—";
    const cost =
      h.costUsd !== null ? `${formatUsd(h.costUsd)} (${formatUsd(h.costPerResolvedUsd)}/res)` : "—";
    return `| ${label} | ${resolved} | ${ci} | ${passAll} | ${latency} | ${tokens} | ${cache} | ${stepOne} | ${stepsTools} | ${cost} |`;
  });

  const heading = `### ${modelFamilyLabel(modelResults.family)} (\`${modelResults.model.id}\`)`;
  const meta = `${dataset.tasks} tasks × ${dataset.attempts} attempts${dataset.reasoning ? `, reasoning: ${dataset.reasoning}` : ""}. Snapshot updated ${modelResults.generatedAt.slice(0, 10)}.`;

  return [
    heading,
    "",
    meta,
    "",
    "| Harness | Resolved | 95% interval | pass^3 | Latency (p50 / p90) | Tokens (in / out) | Cache hit | Step 1 prompt | Steps / tools | Cost |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

export function renderBenchmarkMarkdown(
  results: EveDatasetResults | undefined,
  dataset: string,
): string {
  if (!results) return `No published ${dataset} results yet.`;
  const models = orderedModels(results);
  if (models.length === 0) return `No published ${dataset} results yet.`;
  return models.map((modelResults) => renderModelMarkdown(results, modelResults)).join("\n\n");
}

export function renderBenchmarksPageMarkdown(
  harnessDataset: EveDatasetResults | undefined,
  authoringRows: BenchmarkRow[],
  authoringPublishedAt: string | null,
): string {
  const sections: string[] = [
    "# eve Benchmarks",
    "",
    "Baseline performance of stock `eve` compared against peer coding agent harnesses on identical tasks, models, and Vercel Sandbox environments, followed by eve project authoring benchmarks.",
    "",
    "## Harness Benchmarks (`deepswe-lean@v1`)",
    "",
    renderBenchmarkMarkdown(harnessDataset, "deepswe-lean"),
  ];

  if (harnessDataset) {
    const models = orderedModels(harnessDataset);
    for (const modelResults of models) {
      if (modelResults.taskMatrix.length === 0) continue;
      const harnessOrder = rankedHarnesses(modelResults).map((h) => h.harness);
      const header = `| Task | ${harnessOrder.map((h) => `\`${h}\``).join(" | ")} |`;
      const sep = `| --- | ${harnessOrder.map(() => "---").join(" | ")} |`;
      const taskRows = modelResults.taskMatrix.map((row) => {
        const cols = harnessOrder.map((h) => {
          const cell = row.cells[h];
          return cell ? `${cell.resolved}/${cell.attempts}` : "—";
        });
        return `| \`${row.task}\` | ${cols.join(" | ")} |`;
      });
      sections.push(
        "",
        `#### Per-task pass rate — ${modelFamilyLabel(modelResults.family)} (\`${modelShortName(modelResults.model.id)}\`)`,
        "",
        header,
        sep,
        ...taskRows,
      );
    }
  }

  if (authoringRows.length > 0) {
    const sorted = [...authoringRows].sort(
      (left, right) =>
        (right.guidedSuccessRate ?? -1) - (left.guidedSuccessRate ?? -1) ||
        left.modelDisplayName.localeCompare(right.modelDisplayName),
    );
    const fmtRate = (v: number | null) => (v === null ? "—" : `${Math.round(v)}%`);
    const rows = sorted.map(
      (r) =>
        `| ${r.modelDisplayName} | ${r.harness} | ${formatDurationMs(r.averageDurationMs)} | ${formatUsd(r.averageEstimatedListCostUsd)} | ${fmtRate(r.baselineSuccessRate)} | ${fmtRate(r.guidedSuccessRate)} |`,
    );
    sections.push(
      "",
      "## Authoring Benchmarks",
      "",
      `Coding agents creating and changing eve projects with and without generated \`AGENTS.md\` guidance.${authoringPublishedAt ? ` Snapshot updated ${authoringPublishedAt.slice(0, 10)}.` : ""}`,
      "",
      "| Model | Harness | Duration | Cost | Success rate | With AGENTS.md |",
      "| --- | --- | --- | --- | --- | --- |",
      ...rows,
    );
  }

  return `${sections.join("\n")}\n`;
}
