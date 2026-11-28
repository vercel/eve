import type { EveDatasetResults, EveHarnessScore, EveModelResults } from "./eve-results";
import type { BenchmarkRow } from "./results";

const FAMILY_ORDER = ["openai", "anthropic"];

const FAMILY_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
};

const REFERENCE_HARNESSES = new Set(["eve", "eve-code"]);

export function isReferenceHarness(harness: string): boolean {
  return REFERENCE_HARNESSES.has(harness);
}

export function orderedModels(results: EveDatasetResults): EveModelResults[] {
  return Object.values(results.models).sort((left, right) => {
    const leftIndex = FAMILY_ORDER.indexOf(left.family);
    const rightIndex = FAMILY_ORDER.indexOf(right.family);
    if (leftIndex !== -1 || rightIndex !== -1) {
      if (leftIndex === -1) return 1;
      if (rightIndex === -1) return -1;
      return leftIndex - rightIndex;
    }
    return left.family.localeCompare(right.family);
  });
}

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

export function formatDurationMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const totalSeconds = ms / 1000;
  if (totalSeconds < 10) return `${totalSeconds.toFixed(1)}s`;
  const roundedSeconds = Math.round(totalSeconds);
  const minutes = Math.floor(roundedSeconds / 60);
  const seconds = roundedSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

export function formatTokens(tokens: number | null | undefined): string {
  if (tokens == null || !Number.isFinite(tokens)) return "—";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 10_000) return `${Math.round(tokens / 1_000)}K`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(Math.round(tokens));
}

export function formatPercent(rate: number | null | undefined, decimals = 0): string {
  if (rate == null || !Number.isFinite(rate)) return "—";
  return `${(rate * 100).toFixed(decimals)}%`;
}

export function formatUsd(amount: number | null | undefined): string {
  if (amount == null || !Number.isFinite(amount)) return "—";
  return `$${amount.toFixed(2)}`;
}

export function formatMedianCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function formatSignedDelta(value: number, unit: string): string {
  const rounded = Math.round(value);
  if (rounded === 0) return `±0${unit}`;
  return `${rounded > 0 ? "+" : "−"}${Math.abs(rounded)}${unit}`;
}

export function renderModelMarkdown(
  modelResults: EveModelResults,
  includeTaskMatrix = false,
): string {
  const passAllHeader = `pass^${modelResults.attempts}`;
  const ranked = rankedHarnesses(modelResults);
  const rows = ranked.map((h) => {
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
      h.costUsd != null
        ? h.costPerResolvedUsd != null
          ? `${formatUsd(h.costUsd)} (${formatUsd(h.costPerResolvedUsd)}/res)`
          : formatUsd(h.costUsd)
        : "—";
    return `| ${label} | ${resolved} | ${ci} | ${passAll} | ${latency} | ${tokens} | ${cache} | ${stepOne} | ${stepsTools} | ${cost} |`;
  });

  const heading = `### ${modelFamilyLabel(modelResults.family)} (\`${modelResults.model.id}\`)`;
  const datasetLabel = `${modelResults.dataset.name}@${modelResults.dataset.version}`;
  const meta = `${datasetLabel} · ${modelResults.tasks} tasks × ${modelResults.attempts} attempts${modelResults.reasoning ? `, reasoning: ${modelResults.reasoning}` : ""}. Snapshot updated ${modelResults.generatedAt.slice(0, 10)}.`;

  const lines = [
    heading,
    "",
    meta,
    "",
    `| Harness | Resolved | 95% interval | ${passAllHeader} | Latency (p50 / p90) | Tokens (in / out) | Cache hit | Step 1 prompt | Steps / tools | Cost |`,
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
  ];

  if (includeTaskMatrix && modelResults.taskMatrix.length > 0) {
    const harnessOrder = ranked.map((h) => h.harness);
    const header = `| Task | ${harnessOrder.map((h) => `\`${h}\``).join(" | ")} |`;
    const sep = `| --- | ${harnessOrder.map(() => "---").join(" | ")} |`;
    const taskRows = modelResults.taskMatrix.map((row) => {
      const cols = harnessOrder.map((h) => {
        const cell = row.cells[h];
        return cell ? `${cell.resolved}/${cell.attempts}` : "—";
      });
      return `| \`${row.task}\` | ${cols.join(" | ")} |`;
    });
    lines.push(
      "",
      `#### Per-task pass rate — ${modelFamilyLabel(modelResults.family)} (\`${modelShortName(modelResults.model.id)}\`)`,
      "",
      header,
      sep,
      ...taskRows,
    );
  }

  return lines.join("\n");
}

export function renderBenchmarkMarkdown(
  results: EveDatasetResults | undefined,
  dataset: string,
): string {
  if (!results) return `No published ${dataset} results yet.`;
  const models = orderedModels(results);
  if (models.length === 0) return `No published ${dataset} results yet.`;
  return models.map((modelResults) => renderModelMarkdown(modelResults, false)).join("\n\n");
}

export function renderBenchmarksPageMarkdown(
  harnessDataset: EveDatasetResults | undefined,
  authoringRows: BenchmarkRow[],
  authoringPublishedAt: string | null,
): string {
  const models = harnessDataset ? orderedModels(harnessDataset) : [];
  const datasetTitle = models[0]
    ? `\`${models[0].dataset.name}@${models[0].dataset.version}\``
    : "`deepswe-lean`";

  const sections: string[] = [
    "# eve Benchmarks",
    "",
    "Baseline performance of stock `eve` compared against peer coding agent harnesses on identical tasks, models, and Vercel Sandbox environments, followed by eve project authoring benchmarks.",
    "",
    `## Harness Benchmarks (${datasetTitle})`,
    "",
    models.length > 0
      ? models.map((modelResults) => renderModelMarkdown(modelResults, true)).join("\n\n")
      : "No published harness results yet.",
  ];

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
