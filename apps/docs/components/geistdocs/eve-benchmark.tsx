"use client";

import Link from "next/link";
import { useState } from "react";

import {
  formatDurationMs,
  formatMedianCount,
  formatPercent,
  formatSignedDelta,
  formatTokens,
  isReferenceHarness,
  modelFamilyLabel,
  modelShortName,
  orderedModels,
  rankedHarnesses,
} from "@/lib/evals/eve-format";
import { eveBenchmark, type EveHarnessScore, type EveModelResults } from "@/lib/evals/eve-results";

export const HARNESS_COLORS: Record<string, string> = {
  eve: "#4f6bed",
  "eve-code": "#4f6bed",
  fx: "#2ea043",
  opencode: "#e0803f",
  pi: "#a855f7",
};

const FALLBACK_COLORS = ["#4f6bed", "#2ea043", "#e0803f", "#a855f7", "#d9c24f"];

export function harnessColor(harness: string, index = 0): string {
  return HARNESS_COLORS[harness] ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length]!;
}

type MetricKey = "correctness" | "latency" | "input tokens" | "output tokens" | "tool calls";

interface Metric {
  label: string;
  effectKey?: string;
  higherIsBetter: boolean;
  value: (score: EveHarnessScore) => number | null;
  /** Interval drawn around the dot, when the metric has one. */
  range?: (score: EveHarnessScore) => [number, number] | null;
  format: (value: number) => string;
  /** Difference from the reference contender. */
  delta: (value: number, reference: number) => string;
  /** Fixed axis maximum; otherwise fit to the data. */
  max?: number;
  footnote: string;
}

const relative = (value: number, reference: number) =>
  reference === 0 ? "—" : formatSignedDelta((value / reference - 1) * 100, "%");

const METRICS: Record<MetricKey, Metric> = {
  correctness: {
    label: "correctness",
    effectKey: "resolveRate",
    higherIsBetter: true,
    value: (score) => score.resolveRate.estimate,
    range: (score) => [score.resolveRate.low, score.resolveRate.high],
    format: (value) => formatPercent(value),
    delta: (value, reference) => formatSignedDelta((value - reference) * 100, " pp"),
    max: 1,
    footnote: "Lines are 95% intervals; overlapping lines are not a measured difference.",
  },
  latency: {
    label: "latency",
    effectKey: "latencyMs",
    higherIsBetter: false,
    value: (score) => score.latencyP50Ms,
    range: (score) => [score.latencyP50Ms, score.latencyP90Ms],
    format: (value) => formatDurationMs(value),
    delta: relative,
    footnote: "Dots are median latency; lines extend to p90.",
  },
  "input tokens": {
    label: "input / attempt",
    effectKey: "inputTokens",
    higherIsBetter: false,
    value: (score) => (score.attempts > 0 ? score.inputTokens / score.attempts : null),
    format: (value) => formatTokens(value),
    delta: relative,
    footnote: "Mean input tokens per attempt (including cached tokens).",
  },
  "output tokens": {
    label: "output / attempt",
    higherIsBetter: false,
    value: (score) => (score.attempts > 0 ? score.outputTokens / score.attempts : null),
    format: (value) => formatTokens(value),
    delta: relative,
    footnote: "Mean output tokens per attempt (including reasoning tokens).",
  },
  "tool calls": {
    label: "tools / attempt",
    higherIsBetter: false,
    value: (score) => score.overhead?.toolCallsMedian ?? null,
    format: (value) => formatMedianCount(value),
    delta: relative,
    footnote: "Median tool calls per attempt.",
  },
};

const METRIC_KEYS = Object.keys(METRICS) as MetricKey[];

interface EveBenchmarkProps {
  dataset: string;
  /** Controlled model family key (e.g. "openai" or "anthropic"). */
  family?: string;
  /** Hide the inline model switcher when an outer page controls model selection. */
  hideModelSwitcher?: boolean;
  /** Show a footer link to the full `/benchmarks` hub (useful when embedded in docs). */
  showHubLink?: boolean;
}

/** Renders the latest published eve benchmark comparison plot for one eve-bench dataset. */
export const EveBenchmark = ({
  dataset,
  family,
  hideModelSwitcher = false,
  showHubLink = true,
}: EveBenchmarkProps) => {
  const datasetResults = eveBenchmark.datasets[dataset];
  const models = datasetResults ? orderedModels(datasetResults) : [];
  const [selectedFamily, setSelectedFamily] = useState<string>(models[0]?.family ?? "openai");
  const [metricKey, setMetricKey] = useState<MetricKey>("correctness");

  if (!datasetResults || models.length === 0) {
    return <p>No published {dataset} results yet.</p>;
  }

  const activeFamily = family ?? selectedFamily;
  const activeModel: EveModelResults = datasetResults.models[activeFamily] ?? models[0]!;

  const metric = METRICS[metricKey];
  const rows = rankedHarnesses(activeModel);
  const reference = rows.find((score) => isReferenceHarness(score.harness));
  const numericValues = rows
    .map((score) => metric.value(score))
    .filter((value): value is number => value != null);
  const rangePeaks = rows
    .map((score) => metric.range?.(score)?.[1] ?? metric.value(score))
    .filter((value): value is number => value != null);
  const max = metric.max ?? (rangePeaks.length > 0 ? niceCeiling(Math.max(...rangePeaks)) : 1);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => fraction * max);
  const best =
    numericValues.length > 0
      ? (metric.higherIsBetter ? Math.max : Math.min)(...numericValues)
      : null;
  const position = (value: number) => `${Math.min(100, Math.max(0, (value / max) * 100))}%`;
  const runs = new Set(rows.map((score) => score.runUrl).filter(Boolean)).size;
  const sorted = [...rows].sort((left, right) => {
    const lv = metric.value(left);
    const rv = metric.value(right);
    if (lv == null && rv == null) return 0;
    if (lv == null) return 1;
    if (rv == null) return -1;
    return metric.higherIsBetter ? rv - lv : lv - rv;
  });

  const referenceValue = reference ? metric.value(reference) : null;
  const hasSignificantDiff = sorted.some((score) => {
    const effect = metric.effectKey ? score.effectsVsEve?.[metric.effectKey] : undefined;
    return effect != null && effect.verdict !== "inconclusive";
  });

  return (
    <figure className="not-prose my-6 rounded-xl border border-gray-400 bg-background-100 p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <figcaption className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-mono font-medium text-gray-1000">
            {activeModel.dataset.name}@{activeModel.dataset.version} ·{" "}
            {modelShortName(activeModel.model.id)}
          </span>
          <span className="text-gray-900 text-xs sm:text-sm">
            {rows.length} harnesses · {activeModel.tasks} tasks × {activeModel.attempts} attempts
            {runs > 0 ? ` · ${runs} run${runs === 1 ? "" : "s"}` : ""}
          </span>
        </figcaption>

        {!hideModelSwitcher && models.length > 1 ? (
          <div
            aria-label="Model"
            className="inline-flex flex-wrap rounded-lg border border-gray-400 p-0.5 text-xs"
            role="group"
          >
            {models.map((entry) => {
              const selected = entry.family === activeModel.family;
              return (
                <button
                  aria-pressed={selected}
                  className={`rounded-md px-2.5 py-1 transition-colors focus-visible:outline-2 focus-visible:outline-blue-700 focus-visible:outline-offset-2 ${
                    selected
                      ? "bg-gray-200 font-medium text-gray-1000"
                      : "text-gray-900 hover:text-gray-1000"
                  }`}
                  key={entry.family}
                  onClick={() => setSelectedFamily(entry.family)}
                  type="button"
                >
                  {modelFamilyLabel(entry.family)} · {modelShortName(entry.model.id)}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      <div
        aria-label="Metric"
        className="mt-3 inline-flex flex-wrap rounded-lg border border-gray-400 p-0.5"
        role="group"
      >
        {METRIC_KEYS.map((key) => {
          const selected = key === metricKey;
          return (
            <button
              aria-pressed={selected}
              className={`rounded-md px-2.5 py-1 text-xs focus-visible:outline-2 focus-visible:outline-blue-700 focus-visible:outline-offset-2 sm:px-3 sm:text-sm ${
                selected
                  ? "bg-gray-200 font-medium text-gray-1000"
                  : "text-gray-900 hover:text-gray-1000"
              }`}
              key={key}
              onClick={() => setMetricKey(key)}
              type="button"
            >
              {key}
            </button>
          );
        })}
      </div>

      <div className="mt-4 overflow-x-auto">
        <div className="min-w-[560px]">
          <div className="grid grid-cols-[10.5rem_1fr_7.25rem_5rem] items-end gap-x-3 pb-1 text-gray-900 text-xs sm:text-sm">
            <span>{metric.higherIsBetter ? "higher is better" : "lower is better"}</span>
            <div className="relative h-5 font-mono text-xs">
              {ticks.map((tick, index) => {
                const alignClass =
                  index === 0
                    ? "translate-x-0"
                    : index === ticks.length - 1
                      ? "-translate-x-full"
                      : "-translate-x-1/2";
                return (
                  <span
                    className={`absolute whitespace-nowrap ${alignClass}`}
                    key={tick}
                    style={{ left: position(tick) }}
                  >
                    {metric.format(tick)}
                  </span>
                );
              })}
            </div>
            <span className="text-right">{metric.label}</span>
            <span className="text-right">vs eve</span>
          </div>

          {sorted.map((score, index) => {
            const value = metric.value(score);
            const color = harnessColor(score.harness, index);
            const range = metric.range?.(score);
            const isReference = isReferenceHarness(score.harness);
            const effect = metric.effectKey ? score.effectsVsEve?.[metric.effectKey] : undefined;
            const isSignificant = effect != null && effect.verdict !== "inconclusive";

            return (
              <div
                className={`grid grid-cols-[10.5rem_1fr_7.25rem_5rem] items-center gap-x-3 rounded-md px-1 py-1.5 hover:bg-gray-100 ${
                  isReference ? "bg-gray-100/60" : ""
                }`}
                key={score.harness}
              >
                <span className="flex min-w-0 items-center gap-2 font-mono text-gray-1000">
                  <span className="size-2.5 shrink-0 rounded-full" style={{ background: color }} />
                  <span className="truncate">
                    {score.runUrl ? (
                      <a
                        className="rounded-xs hover:underline focus-visible:outline-2 focus-visible:outline-blue-700 focus-visible:outline-offset-2"
                        href={score.runUrl}
                        rel="noreferrer"
                        target="_blank"
                        title="Open the GitHub Actions run"
                      >
                        {score.harness}
                        {score.version ? `@${score.version}` : ""}
                      </a>
                    ) : (
                      `${score.harness}${score.version ? `@${score.version}` : ""}`
                    )}
                  </span>
                </span>

                <div className="relative h-5">
                  {ticks.map((tick) => (
                    <span
                      className="absolute inset-y-0 w-px bg-gray-300"
                      key={tick}
                      style={{ left: position(tick) }}
                    />
                  ))}
                  {range ? (
                    <span
                      className="absolute top-1/2 h-0.5 -translate-y-1/2 opacity-60"
                      style={{
                        background: color,
                        left: position(range[0]),
                        width: `calc(${position(range[1])} - ${position(range[0])})`,
                      }}
                    />
                  ) : null}
                  {value != null ? (
                    <span
                      aria-label={`${score.harness}: ${metric.format(value)}${range ? `, interval ${metric.format(range[0])} to ${metric.format(range[1])}` : ""}`}
                      className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-background-100 transition-[left] duration-300"
                      role="img"
                      style={{ background: color, left: position(value) }}
                    />
                  ) : null}
                </div>

                <span
                  className={`text-right font-mono ${
                    value != null && best != null && value === best
                      ? "font-semibold text-green-900"
                      : "text-gray-1000"
                  }`}
                >
                  {value == null
                    ? "—"
                    : metricKey === "correctness"
                      ? `${metric.format(value)} (${score.resolved}/${score.attempts})`
                      : metric.format(value)}
                </span>

                <span
                  className={`text-right font-mono ${
                    isReference
                      ? "text-gray-900"
                      : isSignificant
                        ? "font-semibold text-gray-1000"
                        : "text-gray-900"
                  }`}
                  title={
                    effect
                      ? `${score.harness} vs eve: ${effect.better} tasks better, ${effect.worse} tasks worse (${effect.verdict})`
                      : undefined
                  }
                >
                  {isReference || referenceValue == null || value == null
                    ? isReference
                      ? "ref"
                      : "—"
                    : metric.delta(value, referenceValue)}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-gray-900 text-xs">
        <p className="m-0">
          {metric.footnote}
          {hasSignificantDiff ? " Bold deltas are statistically significant vs eve." : ""}
          {runs > 0 ? " Click a contender to open its run." : ""}
        </p>
        {showHubLink ? (
          <Link
            className="rounded-xs font-medium text-gray-1000 underline underline-offset-4 hover:text-gray-800 focus-visible:outline-2 focus-visible:outline-blue-700 focus-visible:outline-offset-2"
            href="/benchmarks"
            prefetch={true}
          >
            Full benchmark breakdown →
          </Link>
        ) : null}
      </div>
    </figure>
  );
};

/** Smallest 1/2/5 × 10ⁿ ceiling above `value`, so axis ticks stay readable. */
function niceCeiling(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const scaled = value / magnitude;
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    if (scaled <= step) return step * magnitude;
  }
  return 10 * magnitude;
}
