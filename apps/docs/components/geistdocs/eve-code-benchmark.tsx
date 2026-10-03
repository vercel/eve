"use client";

import { useState } from "react";

import {
  eveCodeBenchmark,
  rankedHarnesses,
  type EveCodeHarnessScore,
} from "@/lib/evals/eve-code-results";

const REFERENCE = "eve-code";
const COLORS = ["#4f6bed", "#5ed37f", "#e0803f", "#c26bd9", "#d9c24f"];

interface Metric {
  label: string;
  higherIsBetter: boolean;
  value: (score: EveCodeHarnessScore) => number;
  /** Interval drawn around the dot, when the metric has one. */
  range?: (score: EveCodeHarnessScore) => [number, number];
  format: (value: number) => string;
  /** Difference from the reference contender. */
  delta: (value: number, reference: number) => string;
  /** Fixed axis maximum; otherwise fit to the data. */
  max?: number;
}

const signed = (value: number, unit: string) =>
  `${value > 0 ? "+" : value < 0 ? "−" : "±"}${Math.abs(Math.round(value))}${unit}`;
const relative = (value: number, reference: number) =>
  reference === 0 ? "—" : signed((value / reference - 1) * 100, "%");

const METRICS: Record<string, Metric> = {
  correctness: {
    label: "correctness",
    higherIsBetter: true,
    value: (score) => score.resolveRate.estimate,
    range: (score) => [score.resolveRate.low, score.resolveRate.high],
    format: (value) => `${Math.round(value * 100)}%`,
    delta: (value, reference) => signed((value - reference) * 100, " pp"),
    max: 1,
  },
  "input tokens": {
    label: "input tokens",
    higherIsBetter: false,
    value: (score) => score.inputTokens / score.attempts,
    format: (value) =>
      value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : `${Math.round(value / 1000)}k`,
    delta: relative,
  },
  latency: {
    label: "latency",
    higherIsBetter: false,
    value: (score) => score.latencyP50Ms,
    range: (score) => [score.latencyP50Ms, score.latencyP90Ms],
    format: (value) => `${Math.round(value / 1000)}s`,
    delta: relative,
  },
};

/** Renders the latest published eve-code results for one eve-bench dataset. */
export const EveCodeBenchmark = ({ dataset }: { dataset: string }) => {
  const [metricKey, setMetricKey] = useState("correctness");
  const results = eveCodeBenchmark.datasets[dataset];
  if (!results) return <p>No published {dataset} results yet.</p>;

  const metric = METRICS[metricKey];
  const rows = rankedHarnesses(results);
  const colors = new Map(
    rows.map((score, index) => [score.harness, COLORS[index % COLORS.length]]),
  );
  const reference = rows.find((score) => score.harness === REFERENCE);
  const max =
    metric.max ??
    niceCeiling(Math.max(...rows.map((score) => metric.range?.(score)[1] ?? metric.value(score))));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => fraction * max);
  const best = (metric.higherIsBetter ? Math.max : Math.min)(...rows.map(metric.value));
  const position = (value: number) => `${(value / max) * 100}%`;
  const runs = new Set(rows.map((score) => score.runUrl)).size;
  const sorted = [...rows].sort((left, right) =>
    metric.higherIsBetter
      ? metric.value(right) - metric.value(left)
      : metric.value(left) - metric.value(right),
  );

  return (
    <figure className="not-prose my-6 overflow-x-auto rounded-xl border border-gray-400 bg-background-100 p-4 text-sm">
      <figcaption className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono font-medium text-gray-1000">
          {results.dataset.name}@{results.dataset.version} · {results.model.id.split("/").at(-1)}
        </span>
        <span className="text-gray-800">
          {rows.length} contenders across {runs} run{runs === 1 ? "" : "s"}
        </span>
      </figcaption>

      <div
        aria-label="Metric"
        className="mt-3 inline-flex rounded-lg border border-gray-400 p-0.5"
        role="tablist"
      >
        {Object.keys(METRICS).map((key) => (
          <button
            aria-selected={key === metricKey}
            className={`rounded-md px-3 py-1 ${key === metricKey ? "bg-gray-200 text-gray-1000" : "text-gray-800 hover:text-gray-1000"}`}
            key={key}
            onClick={() => setMetricKey(key)}
            role="tab"
            type="button"
          >
            {key}
          </button>
        ))}
      </div>

      <div className="mt-4 min-w-[640px]" role="tabpanel">
        <div className="grid grid-cols-[12rem_1fr_6rem_5rem] items-end gap-x-4 pb-1 text-gray-800">
          <span>{metric.higherIsBetter ? "higher is better" : "lower is better"}</span>
          <div className="relative h-5 font-mono text-xs">
            {ticks.map((tick) => (
              <span
                className="absolute -translate-x-1/2"
                key={tick}
                style={{ left: position(tick) }}
              >
                {metric.format(tick)}
              </span>
            ))}
          </div>
          <span className="text-right">{metric.label}</span>
          <span className="text-right">vs ref</span>
        </div>

        {sorted.map((score) => {
          const value = metric.value(score);
          const color = colors.get(score.harness);
          const range = metric.range?.(score);
          const isReference = score.harness === REFERENCE;
          return (
            <div
              className="grid grid-cols-[12rem_1fr_6rem_5rem] items-center gap-x-4 rounded-md py-1.5 hover:bg-gray-100"
              key={score.harness}
            >
              <span className="flex min-w-0 items-center gap-2 font-mono text-gray-1000">
                <span className="size-2.5 shrink-0 rounded-full" style={{ background: color }} />
                <span className="truncate">
                  {score.runUrl ? (
                    <a href={score.runUrl} title="Open the GitHub Actions run">
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
                <span
                  aria-label={`${score.harness}: ${metric.format(value)}${range ? `, interval ${metric.format(range[0])} to ${metric.format(range[1])}` : ""}`}
                  className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-background-100 transition-[left] duration-300"
                  role="img"
                  style={{ background: color, left: position(value) }}
                />
              </div>

              <span
                className={`text-right font-mono ${value === best ? "text-green-700" : "text-gray-1000"}`}
              >
                {metric.format(value)}
              </span>
              <span className="text-right font-mono text-gray-900">
                {isReference || !reference ? "ref" : metric.delta(value, metric.value(reference))}
              </span>
            </div>
          );
        })}
      </div>

      <p className="mt-3 text-gray-700 text-xs">
        {metric.range
          ? metricKey === "latency"
            ? "Dots are median latency; lines extend to p90."
            : "Lines are 95% intervals; overlapping lines are not a measured difference."
          : "Mean input tokens per attempt."}{" "}
        Click a contender to open its run.
      </p>
    </figure>
  );
};

function niceCeiling(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((candidate) => candidate * magnitude >= value) ?? 10;
  return step * magnitude;
}
