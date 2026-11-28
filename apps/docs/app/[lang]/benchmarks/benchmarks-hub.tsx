"use client";

import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon, ExternalLinkIcon } from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";

import { EveBenchmark, harnessColor } from "@/components/geistdocs/eve-benchmark";
import {
  formatDurationMs,
  formatMedianCount,
  formatPercent,
  formatTokens,
  formatUsd,
  isReferenceHarness,
  modelFamilyLabel,
  modelShortName,
  orderedModels,
  rankedHarnesses,
} from "@/lib/evals/eve-format";
import type { EveDatasetResults, EveHarnessScore, EveModelResults } from "@/lib/evals/eve-results";
import type { BenchmarkRow } from "@/lib/evals/results";
import { ResultsTable } from "./results-table";

export type HubView = "harness" | "authoring";
type TaskMetric = "resolved" | "latency" | "tokens";
type ScorecardSortKey =
  | "harness"
  | "resolveRate"
  | "passAllRate"
  | "latencyP50Ms"
  | "inputTokens"
  | "cachedShare"
  | "firstStepInputTokens"
  | "toolCallsMedian"
  | "costUsd";
type SortDirection = "ascending" | "descending";

interface BenchmarksHubProps {
  harnessDataset: EveDatasetResults | undefined;
  authoringRows: BenchmarkRow[];
  authoringRetiredRows: BenchmarkRow[];
  authoringPublishedAt: string | null;
  authoringRevision: string | null;
  initialView?: HubView;
  initialFamily?: string;
}

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-blue-700 focus-visible:outline-offset-2";

function bestOf(
  values: ReadonlyArray<number | null | undefined>,
  mode: "min" | "max",
): number | null {
  const valid = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (valid.length === 0) return null;
  return mode === "min" ? Math.min(...valid) : Math.max(...valid);
}

export const BenchmarksHub = ({
  harnessDataset,
  authoringRows,
  authoringRetiredRows,
  authoringPublishedAt,
  authoringRevision,
  initialView = "harness",
  initialFamily,
}: BenchmarksHubProps) => {
  const models = useMemo(
    () => (harnessDataset ? orderedModels(harnessDataset) : []),
    [harnessDataset],
  );
  const defaultFamily = models[0]?.family ?? "openai";
  const resolvedInitialFamily =
    initialFamily && models.some((m) => m.family === initialFamily) ? initialFamily : defaultFamily;

  const [view, setView] = useState<HubView>(initialView);
  const [selectedFamily, setSelectedFamily] = useState<string>(resolvedInitialFamily);
  const harnessTabRef = useRef<HTMLButtonElement>(null);
  const authoringTabRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setView(initialView);
  }, [initialView]);

  useEffect(() => {
    setSelectedFamily(resolvedInitialFamily);
  }, [resolvedInitialFamily]);

  useEffect(() => {
    const onPopState = () => {
      const params = new URLSearchParams(window.location.search);
      const paramView = params.get("view");
      setView(paramView === "authoring" ? "authoring" : "harness");
      const paramModel = params.get("model");
      setSelectedFamily(
        paramModel && models.some((m) => m.family === paramModel) ? paramModel : defaultFamily,
      );
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [defaultFamily, models]);

  const syncQuery = (nextView: HubView, nextFamily: string) => {
    const url = new URL(window.location.href);
    if (nextView === "authoring") {
      url.searchParams.set("view", "authoring");
      url.searchParams.delete("model");
    } else {
      url.searchParams.delete("view");
      if (nextFamily !== defaultFamily) {
        url.searchParams.set("model", nextFamily);
      } else {
        url.searchParams.delete("model");
      }
    }
    window.history.replaceState(null, "", url.toString());
  };

  const handleViewChange = (next: HubView) => {
    setView(next);
    syncQuery(next, selectedFamily);
  };

  const handleModelChange = (nextFamily: string) => {
    setSelectedFamily(nextFamily);
    syncQuery("harness", nextFamily);
  };

  const handleSuiteTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const next: HubView = view === "harness" ? "authoring" : "harness";
      handleViewChange(next);
      (next === "harness" ? harnessTabRef : authoringTabRef).current?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      handleViewChange("harness");
      harnessTabRef.current?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      handleViewChange("authoring");
      authoringTabRef.current?.focus();
    }
  };

  const activeModel =
    (harnessDataset ? harnessDataset.models[selectedFamily] : undefined) ?? models[0];

  return (
    <main className="mx-auto w-full min-w-0 max-w-[1080px] px-4 pb-32 sm:px-6">
      <section className="flex min-w-0 flex-col items-center px-0 pt-14 pb-8 text-center sm:px-4 sm:pt-16">
        <h1 className="text-gray-1000 text-heading-48 sm:text-heading-64">Benchmarks</h1>
        <p className="mt-4 max-w-3xl text-base text-gray-900 sm:text-lg">
          {view === "harness"
            ? "Stock eve benchmarked against peer coding agent harnesses on identical DeepSWE-lean tasks, models, and isolated Vercel Sandboxes."
            : "Performance of coding agents creating and changing eve projects with and without generated AGENTS.md guidance."}
        </p>

        <div
          aria-label="Benchmark suite"
          className="mt-6 inline-flex rounded-xl border border-gray-400 bg-background-100 p-1 text-xs sm:text-sm"
          role="tablist"
        >
          <button
            aria-controls="panel-harness"
            aria-selected={view === "harness"}
            className={`whitespace-nowrap rounded-lg px-3 py-1.5 transition-colors sm:px-4 ${FOCUS_RING} ${
              view === "harness"
                ? "bg-gray-200 font-medium text-gray-1000"
                : "text-gray-900 hover:text-gray-1000"
            }`}
            id="tab-harness"
            onClick={() => handleViewChange("harness")}
            onKeyDown={handleSuiteTabKeyDown}
            ref={harnessTabRef}
            role="tab"
            tabIndex={view === "harness" ? 0 : -1}
            type="button"
          >
            Harness Benchmarks
          </button>
          <button
            aria-controls="panel-authoring"
            aria-selected={view === "authoring"}
            className={`whitespace-nowrap rounded-lg px-3 py-1.5 transition-colors sm:px-4 ${FOCUS_RING} ${
              view === "authoring"
                ? "bg-gray-200 font-medium text-gray-1000"
                : "text-gray-900 hover:text-gray-1000"
            }`}
            id="tab-authoring"
            onClick={() => handleViewChange("authoring")}
            onKeyDown={handleSuiteTabKeyDown}
            ref={authoringTabRef}
            role="tab"
            tabIndex={view === "authoring" ? 0 : -1}
            type="button"
          >
            Authoring Benchmarks
          </button>
        </div>
      </section>

      {view === "harness" ? (
        <div aria-labelledby="tab-harness" id="panel-harness" role="tabpanel">
          {harnessDataset && activeModel ? (
            <div className="space-y-10">
              <section aria-labelledby="model-overview">
                <h2 className="sr-only" id="model-overview">
                  Model summary
                </h2>
                <div className="grid grid-cols-1 gap-4 min-[768px]:grid-cols-2">
                  {models.map((entry) => (
                    <ModelOverviewCard
                      isSelected={entry.family === activeModel.family}
                      key={entry.family}
                      modelResults={entry}
                      onSelect={() => handleModelChange(entry.family)}
                    />
                  ))}
                </div>
              </section>

              <SelectedModelMetaBar modelResults={activeModel} />

              <section aria-labelledby="metric-comparison">
                <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="font-semibold text-gray-1000 text-xl" id="metric-comparison">
                    Metric Comparison
                  </h2>
                  <span className="font-mono text-gray-900 text-xs">
                    {modelFamilyLabel(activeModel.family)} · {activeModel.model.id}
                  </span>
                </div>
                <EveBenchmark
                  dataset={activeModel.dataset.name}
                  family={activeModel.family}
                  hideModelSwitcher
                  showHubLink={false}
                />
              </section>

              <section aria-labelledby="full-scorecard">
                <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="font-semibold text-gray-1000 text-xl" id="full-scorecard">
                    Full Scorecard
                  </h2>
                  <span className="text-gray-900 text-xs">
                    Totals across {activeModel.tasks * activeModel.attempts} attempts; latency, Step
                    1, and steps/tools are per-attempt medians
                  </span>
                </div>
                <HarnessScorecardTable modelResults={activeModel} />
                <p className="mt-2.5 text-gray-900 text-xs leading-5">
                  Billed cost is reported directly by harnesses that surface AI Gateway billing (
                  <code>eve</code> and <code>opencode</code>); <code>pi</code> and <code>fx</code>{" "}
                  omit cost, so compare input/output tokens and cache hit rate across all harnesses.{" "}
                  <code>fx</code> reports tool calls without model step counts or first-step prompt
                  size.
                </p>
              </section>

              {activeModel.taskMatrix.length > 0 ? (
                <section aria-labelledby="task-breakdown">
                  <TaskBreakdownSection modelResults={activeModel} />
                </section>
              ) : null}

              <section aria-labelledby="overhead-profile">
                <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="font-semibold text-gray-1000 text-xl" id="overhead-profile">
                    Overhead & Tool Profile
                  </h2>
                  <span className="text-gray-900 text-xs">
                    System prompt footprint, root-session steps, and top tools called across{" "}
                    {activeModel.tasks * activeModel.attempts} attempts
                  </span>
                </div>
                <OverheadProfileGrid modelResults={activeModel} />
              </section>

              <section aria-labelledby="methodology">
                <h2 className="mb-3 font-semibold text-gray-1000 text-xl" id="methodology">
                  Methodology & Updates
                </h2>
                <div className="grid grid-cols-1 gap-4 min-[768px]:grid-cols-2">
                  <div className="rounded-xl border border-gray-400 bg-background-100 p-4 text-gray-900 text-sm leading-6">
                    <h3 className="font-medium text-gray-1000">How the benchmark runs</h3>
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-gray-900 text-xs leading-5 sm:text-sm">
                      <li>
                        Dataset:{" "}
                        <code>
                          {activeModel.dataset.name}@{activeModel.dataset.version}
                        </code>{" "}
                        ({activeModel.tasks} feature and bug-fix tasks × {activeModel.attempts}{" "}
                        attempts each).
                      </li>
                      <li>
                        Stock <code>eve</code> (<code>apps/bench-agent</code> on{" "}
                        <code>HostSandbox</code>) runs against <code>opencode</code>,{" "}
                        <code>pi</code>, and{" "}
                        <a
                          className={`rounded-xs text-gray-1000 underline underline-offset-4 ${FOCUS_RING}`}
                          href="https://fx.sh"
                          rel="noreferrer"
                          target="_blank"
                        >
                          fx
                        </a>{" "}
                        with identical models and{" "}
                        <code>reasoning: {activeModel.reasoning ?? "high"}</code>.
                      </li>
                      <li>
                        Every attempt gets a fresh Vercel Sandbox with a 20-minute limit. Only
                        passes verified by the DeepSWE test harness count; crashes and timeouts
                        score 0.
                      </li>
                      <li>
                        95% intervals use 10,000 task-level bootstrap resamples. Overlapping
                        intervals indicate a statistical tie on a {activeModel.tasks}-task slice.
                      </li>
                    </ul>
                  </div>
                  <div className="rounded-xl border border-gray-400 bg-background-100 p-4 text-gray-900 text-sm leading-6">
                    <h3 className="font-medium text-gray-1000">How results refresh</h3>
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-gray-900 text-xs leading-5 sm:text-sm">
                      <li>
                        The <code>eve</code> benchmark workflow runs weekly on Mondays at 06:00 UTC
                        and on manual dispatch from <code>main</code> across both OpenAI and
                        Anthropic.
                      </li>
                      <li>
                        Complete full-dataset runs automatically refresh{" "}
                        <code>apps/docs/lib/evals/eve-benchmark.json</code> via a signed bot PR.
                      </li>
                      <li>
                        Every harness entry links directly to the public GitHub Actions run that
                        produced it.
                      </li>
                      <li>
                        Agents can read all tables directly in Markdown at{" "}
                        <a
                          className={`rounded-xs font-mono text-gray-1000 underline underline-offset-4 ${FOCUS_RING}`}
                          href="/benchmarks.md"
                        >
                          /benchmarks.md
                        </a>
                        .
                      </li>
                    </ul>
                  </div>
                </div>
              </section>
            </div>
          ) : (
            <div className="rounded-xl border border-gray-400 bg-background-100 p-8 text-center text-gray-900 text-sm">
              No published harness benchmark results yet.
            </div>
          )}
        </div>
      ) : (
        <div aria-labelledby="tab-authoring" id="panel-authoring" role="tabpanel">
          <div className="mb-6 flex flex-wrap items-center justify-center gap-x-3 gap-y-2 text-gray-900 text-sm">
            <span>
              Last published:{" "}
              <span className="font-medium text-gray-1000">
                {formatLongDate(authoringPublishedAt)}
              </span>
            </span>
            <span aria-hidden="true" className="hidden text-gray-500 sm:inline">
              ·
            </span>
            <span>
              eve revision:{" "}
              {authoringRevision ? (
                <a
                  className={`rounded-xs font-mono font-medium text-gray-1000 underline underline-offset-4 ${FOCUS_RING}`}
                  href={`https://github.com/vercel/eve/commit/${authoringRevision}`}
                  rel="noreferrer"
                  target="_blank"
                >
                  {authoringRevision.slice(0, 8)}
                </a>
              ) : (
                <span className="text-gray-900">N/A</span>
              )}
            </span>
          </div>

          <section aria-labelledby="authoring-current-results">
            <h2 className="sr-only" id="authoring-current-results">
              Current authoring results
            </h2>
            <ResultsTable rows={authoringRows} />
          </section>

          {authoringRetiredRows.length > 0 ? (
            <section className="mt-8" aria-labelledby="retired-models">
              <h2 className="text-heading-24 text-gray-1000" id="retired-models">
                Retired Models
              </h2>
              <div className="mt-3">
                <ResultsTable rows={authoringRetiredRows} showMeasurementDate />
              </div>
            </section>
          ) : null}

          <p className="mt-8 text-gray-900 text-sm leading-6">
            Each model completes the same deterministic eve authoring tasks three times with and
            without the guidance files generated by <code>eve init</code>; success rates include
            every scheduled run, while duration, tokens, and tool calls average valid runs. Cost
            estimates apply provider public list prices to recorded token usage.
          </p>
        </div>
      )}
    </main>
  );
};

const ModelOverviewCard = ({
  modelResults,
  isSelected,
  onSelect,
}: {
  modelResults: EveModelResults;
  isSelected: boolean;
  onSelect: () => void;
}) => {
  const ranked = rankedHarnesses(modelResults);
  const eveIndex = ranked.findIndex((h) => isReferenceHarness(h.harness));
  const eve = eveIndex >= 0 ? ranked[eveIndex] : ranked[0];
  if (!eve) return null;

  const rank = eveIndex >= 0 ? eveIndex + 1 : 1;
  const fastestLatency = bestOf(
    ranked.map((h) => h.latencyP50Ms),
    "min",
  );
  const lowestInput = bestOf(
    ranked.map((h) => h.inputTokens),
    "min",
  );
  const topHarness = ranked[0]!;
  const isTiedWithLeader =
    rank > 1 &&
    (topHarness.resolveRate.estimate === eve.resolveRate.estimate ||
      topHarness.effectsVsEve?.resolveRate?.verdict === "inconclusive");

  return (
    <button
      aria-pressed={isSelected}
      className={`group flex w-full flex-col rounded-xl border p-5 text-left transition-all ${FOCUS_RING} ${
        isSelected
          ? "border-gray-1000 bg-background-100 shadow-xs ring-1 ring-gray-1000/20"
          : "border-gray-400 bg-background-100 hover:border-gray-700"
      }`}
      onClick={onSelect}
      type="button"
    >
      <div className="flex w-full items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-gray-900 text-xs uppercase tracking-wider">
              {modelFamilyLabel(modelResults.family)}
            </span>
            {modelResults.model.released ? (
              <span className="font-mono text-gray-900 text-xs">{modelResults.model.released}</span>
            ) : null}
          </div>
          <div className="mt-0.5 truncate font-mono font-semibold text-base text-gray-1000 sm:text-lg">
            {modelShortName(modelResults.model.id)}
          </div>
        </div>
        <span
          className={`shrink-0 rounded-full border px-2.5 py-0.5 font-mono text-xs ${
            rank === 1
              ? "border-green-400 bg-green-100 font-medium text-green-900"
              : "border-gray-400 bg-gray-100 text-gray-1000"
          }`}
        >
          {rank === 1
            ? `#1 of ${ranked.length}`
            : `#${rank} of ${ranked.length}${isTiedWithLeader ? " · tie" : ""}`}
        </span>
      </div>

      <div className="mt-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 border-gray-300 border-b pb-4">
        <div>
          <span className="font-mono font-semibold text-3xl text-gray-1000">
            {formatPercent(eve.resolveRate.estimate)}
          </span>
          <span className="ml-2 font-mono text-gray-900 text-sm">
            {eve.resolved}/{eve.attempts} resolved
          </span>
        </div>
        <span className="font-mono text-gray-900 text-xs">
          {eve.harness}
          {eve.version ? `@${eve.version}` : ""}
        </span>
      </div>

      <div className="mt-3 grid w-full grid-cols-3 gap-2 text-xs">
        <div>
          <div className="text-gray-900">Latency p50</div>
          <div
            className={`mt-0.5 font-mono font-medium ${
              fastestLatency != null && eve.latencyP50Ms === fastestLatency
                ? "text-green-900"
                : "text-gray-1000"
            }`}
          >
            {formatDurationMs(eve.latencyP50Ms)}
            {fastestLatency != null && eve.latencyP50Ms === fastestLatency ? " (#1)" : ""}
          </div>
        </div>
        <div>
          <div className="text-gray-900">Input tokens</div>
          <div
            className={`mt-0.5 font-mono font-medium ${
              lowestInput != null && eve.inputTokens === lowestInput
                ? "text-green-900"
                : "text-gray-1000"
            }`}
          >
            {formatTokens(eve.inputTokens)}
            {lowestInput != null && eve.inputTokens === lowestInput ? " (#1)" : ""}
          </div>
        </div>
        <div>
          <div className="text-gray-900">pass^{modelResults.attempts}</div>
          <div className="mt-0.5 font-mono font-medium text-gray-1000">
            {formatPercent(eve.passAllRate)}
          </div>
        </div>
      </div>

      <div className="mt-4 w-full space-y-1.5">
        {ranked.map((entry, index) => {
          const isEve = isReferenceHarness(entry.harness);
          return (
            <div
              className="grid grid-cols-[5.5rem_1fr_3rem] items-center gap-2 text-xs"
              key={entry.harness}
            >
              <span
                className={`truncate font-mono ${
                  isEve ? "font-semibold text-gray-1000" : "text-gray-900"
                }`}
              >
                {entry.harness}
              </span>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-200">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.round(entry.resolveRate.estimate * 100)}%`,
                    background: harnessColor(entry.harness, index),
                    opacity: isEve ? 1 : 0.65,
                  }}
                />
              </div>
              <span className="text-right font-mono text-gray-1000">
                {formatPercent(entry.resolveRate.estimate)}
              </span>
            </div>
          );
        })}
      </div>
    </button>
  );
};

const SelectedModelMetaBar = ({ modelResults }: { modelResults: EveModelResults }) => {
  const eve = modelResults.harnesses.find((h) => isReferenceHarness(h.harness));
  const revision = eve?.source ?? null;
  const runUrl = modelResults.runUrl ?? eve?.runUrl ?? null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl border border-gray-300 bg-gray-100/70 px-4 py-2.5 text-gray-900 text-xs sm:text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-mono font-medium text-gray-1000">
          {modelResults.dataset.name}@{modelResults.dataset.version}
        </span>
        <span aria-hidden="true" className="text-gray-500">
          ·
        </span>
        <span>
          {modelResults.tasks} tasks × {modelResults.attempts} attempts
        </span>
        {modelResults.reasoning ? (
          <>
            <span aria-hidden="true" className="text-gray-500">
              ·
            </span>
            <span>
              reasoning: <code className="text-gray-1000">{modelResults.reasoning}</code>
            </span>
          </>
        ) : null}
        {revision ? (
          <>
            <span aria-hidden="true" className="text-gray-500">
              ·
            </span>
            <span>
              eve:{" "}
              <a
                className={`rounded-xs font-mono font-medium text-gray-1000 underline underline-offset-4 ${FOCUS_RING}`}
                href={`https://github.com/vercel/eve/commit/${revision}`}
                rel="noreferrer"
                target="_blank"
              >
                {revision.slice(0, 7)}
              </a>
            </span>
          </>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>Updated {formatLongDate(modelResults.generatedAt)}</span>
        {runUrl ? (
          <a
            className={`inline-flex items-center gap-1 rounded-xs font-medium text-gray-1000 underline underline-offset-4 ${FOCUS_RING}`}
            href={runUrl}
            rel="noreferrer"
            target="_blank"
          >
            Actions run
            <ExternalLinkIcon aria-hidden="true" className="size-3" />
          </a>
        ) : null}
      </div>
    </div>
  );
};

const HarnessScorecardTable = ({ modelResults }: { modelResults: EveModelResults }) => {
  const [sort, setSort] = useState<{ key: ScorecardSortKey; direction: SortDirection }>({
    key: "resolveRate",
    direction: "descending",
  });

  const toggleSort = (key: ScorecardSortKey) => {
    setSort((current) =>
      current.key === key
        ? {
            key,
            direction: current.direction === "ascending" ? "descending" : "ascending",
          }
        : {
            key,
            direction:
              key === "resolveRate" || key === "passAllRate" || key === "cachedShare"
                ? "descending"
                : "ascending",
          },
    );
  };

  const rows = useMemo(() => {
    const valueOf = (row: EveHarnessScore, key: ScorecardSortKey): number | string | null => {
      switch (key) {
        case "harness":
          return row.harness;
        case "resolveRate":
          return row.resolveRate.estimate;
        case "passAllRate":
          return row.passAllRate ?? null;
        case "latencyP50Ms":
          return row.latencyP50Ms;
        case "inputTokens":
          return row.inputTokens;
        case "cachedShare":
          return row.cachedShare ?? null;
        case "firstStepInputTokens":
          return row.overhead?.firstStepInputTokens ?? null;
        case "toolCallsMedian":
          return row.overhead?.toolCallsMedian ?? null;
        case "costUsd":
          return row.costUsd ?? null;
      }
    };

    return [...modelResults.harnesses].sort((left, right) => {
      const lv = valueOf(left, sort.key);
      const rv = valueOf(right, sort.key);
      if (lv == null && rv == null) return 0;
      if (lv == null) return 1;
      if (rv == null) return -1;
      const cmp =
        typeof lv === "string" && typeof rv === "string"
          ? lv.localeCompare(rv)
          : (lv as number) - (rv as number);
      if (cmp !== 0) return sort.direction === "ascending" ? cmp : -cmp;
      return right.resolveRate.estimate - left.resolveRate.estimate;
    });
  }, [modelResults.harnesses, sort]);

  const bestResolve = bestOf(
    rows.map((r) => r.resolveRate.estimate),
    "max",
  );
  const bestPassAll = bestOf(
    rows.map((r) => r.passAllRate),
    "max",
  );
  const bestLatency = bestOf(
    rows.map((r) => r.latencyP50Ms),
    "min",
  );
  const bestInput = bestOf(
    rows.map((r) => r.inputTokens),
    "min",
  );
  const bestOutput = bestOf(
    rows.map((r) => r.outputTokens),
    "min",
  );
  const bestCache = bestOf(
    rows.map((r) => r.cachedShare),
    "max",
  );
  const bestStepOne = bestOf(
    rows.map((r) => r.overhead?.firstStepInputTokens),
    "min",
  );
  const bestTools = bestOf(
    rows.map((r) => r.overhead?.toolCallsMedian),
    "min",
  );
  const bestCostUsd = bestOf(
    rows.map((r) => r.costUsd),
    "min",
  );
  const bestCostPerResolved = bestOf(
    rows.map((r) => r.costPerResolvedUsd),
    "min",
  );

  const taskDenominator = modelResults.taskMatrix.length || modelResults.tasks;

  return (
    <div className="overflow-x-auto rounded-xl border border-gray-400 bg-background-100">
      <table className="w-full min-w-[780px] border-collapse text-left text-xs sm:text-sm">
        <thead className="bg-gray-100 text-gray-900 text-xs">
          <tr>
            <SortableTh
              label="Harness"
              onClick={() => toggleSort("harness")}
              sort={sort}
              sortKey="harness"
            />
            <SortableTh
              align="right"
              label="Resolved"
              onClick={() => toggleSort("resolveRate")}
              sort={sort}
              sortKey="resolveRate"
            />
            <SortableTh
              align="right"
              label={`pass^${modelResults.attempts}`}
              onClick={() => toggleSort("passAllRate")}
              sort={sort}
              sortKey="passAllRate"
            />
            <SortableTh
              align="right"
              label="Latency"
              onClick={() => toggleSort("latencyP50Ms")}
              sort={sort}
              sortKey="latencyP50Ms"
            />
            <SortableTh
              align="right"
              label="Tokens"
              onClick={() => toggleSort("inputTokens")}
              sort={sort}
              sortKey="inputTokens"
            />
            <SortableTh
              align="right"
              label="Cache"
              onClick={() => toggleSort("cachedShare")}
              sort={sort}
              sortKey="cachedShare"
            />
            <SortableTh
              align="right"
              label="Step 1"
              onClick={() => toggleSort("firstStepInputTokens")}
              sort={sort}
              sortKey="firstStepInputTokens"
            />
            <SortableTh
              align="right"
              label="Steps / tools"
              onClick={() => toggleSort("toolCallsMedian")}
              sort={sort}
              sortKey="toolCallsMedian"
            />
            <SortableTh
              align="right"
              label="Cost"
              onClick={() => toggleSort("costUsd")}
              sort={sort}
              sortKey="costUsd"
            />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const isEve = isReferenceHarness(row.harness);
            return (
              <tr
                className={`border-gray-300 border-t ${isEve ? "bg-gray-100/70" : "hover:bg-gray-100/40"}`}
                key={row.harness}
              >
                <td className="whitespace-nowrap px-3 py-3 font-mono text-gray-1000">
                  <div className="flex items-center gap-2">
                    <span
                      className="size-2.5 shrink-0 rounded-full"
                      style={{ background: harnessColor(row.harness, index) }}
                    />
                    {row.runUrl ? (
                      <a
                        className={`rounded-xs font-medium hover:underline ${FOCUS_RING}`}
                        href={row.runUrl}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {row.harness}
                        {row.version ? `@${row.version}` : ""}
                      </a>
                    ) : (
                      <span className="font-medium">
                        {row.harness}
                        {row.version ? `@${row.version}` : ""}
                      </span>
                    )}
                  </div>
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-right font-mono">
                  <div
                    className={
                      bestResolve != null && row.resolveRate.estimate === bestResolve
                        ? "font-semibold text-green-900"
                        : "text-gray-1000"
                    }
                  >
                    {formatPercent(row.resolveRate.estimate)} ({row.resolved}/{row.attempts})
                  </div>
                  <div className="text-gray-900 text-xs">
                    {formatPercent(row.resolveRate.low)}–{formatPercent(row.resolveRate.high)}
                  </div>
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-right font-mono">
                  <div
                    className={
                      bestPassAll != null && row.passAllRate === bestPassAll
                        ? "font-semibold text-green-900"
                        : "text-gray-1000"
                    }
                  >
                    {formatPercent(row.passAllRate)}
                  </div>
                  {row.passAllTasks != null ? (
                    <div className="text-gray-900 text-xs">
                      {row.passAllTasks}/{taskDenominator} tasks
                    </div>
                  ) : null}
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-right font-mono">
                  <div
                    className={
                      bestLatency != null && row.latencyP50Ms === bestLatency
                        ? "font-semibold text-green-900"
                        : "text-gray-1000"
                    }
                  >
                    {formatDurationMs(row.latencyP50Ms)}
                  </div>
                  <div className="text-gray-900 text-xs">
                    p90 {formatDurationMs(row.latencyP90Ms)}
                  </div>
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-right font-mono">
                  <div
                    className={
                      bestInput != null && row.inputTokens === bestInput
                        ? "font-semibold text-green-900"
                        : "text-gray-1000"
                    }
                  >
                    {formatTokens(row.inputTokens)} in
                  </div>
                  <div
                    className={
                      bestOutput != null && row.outputTokens === bestOutput
                        ? "font-medium text-green-900 text-xs"
                        : "text-gray-900 text-xs"
                    }
                  >
                    {formatTokens(row.outputTokens)} out
                  </div>
                </td>
                <td
                  className={`whitespace-nowrap px-3 py-3 text-right font-mono ${
                    bestCache != null && row.cachedShare === bestCache
                      ? "font-semibold text-green-900"
                      : "text-gray-1000"
                  }`}
                >
                  {formatPercent(row.cachedShare, 1)}
                </td>
                <td
                  className={`whitespace-nowrap px-3 py-3 text-right font-mono ${
                    bestStepOne != null && row.overhead?.firstStepInputTokens === bestStepOne
                      ? "font-semibold text-green-900"
                      : "text-gray-1000"
                  }`}
                >
                  {formatTokens(row.overhead?.firstStepInputTokens ?? null)}
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-right font-mono">
                  <div
                    className={
                      bestTools != null && row.overhead?.toolCallsMedian === bestTools
                        ? "font-semibold text-green-900"
                        : "text-gray-1000"
                    }
                  >
                    {formatMedianCount(row.overhead?.modelStepsMedian ?? null)} /{" "}
                    {formatMedianCount(row.overhead?.toolCallsMedian ?? null)}
                  </div>
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-right font-mono">
                  {row.costUsd != null ? (
                    <>
                      <div
                        className={
                          bestCostUsd != null && row.costUsd === bestCostUsd
                            ? "font-semibold text-green-900"
                            : "text-gray-1000"
                        }
                      >
                        {formatUsd(row.costUsd)}
                      </div>
                      {row.costPerResolvedUsd != null ? (
                        <div
                          className={
                            bestCostPerResolved != null &&
                            row.costPerResolvedUsd === bestCostPerResolved
                              ? "font-medium text-green-900 text-xs"
                              : "text-gray-900 text-xs"
                          }
                        >
                          {formatUsd(row.costPerResolvedUsd)}/res
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <span className="text-gray-900">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

const SortableTh = ({
  label,
  sortKey,
  sort,
  onClick,
  align = "left",
}: {
  label: string;
  sortKey: ScorecardSortKey;
  sort: { key: ScorecardSortKey; direction: SortDirection };
  onClick: () => void;
  align?: "left" | "right";
}) => {
  const active = sort.key === sortKey;
  const SortIcon = !active
    ? ArrowUpDownIcon
    : sort.direction === "ascending"
      ? ArrowUpIcon
      : ArrowDownIcon;

  return (
    <th
      aria-sort={active ? sort.direction : "none"}
      className={`whitespace-nowrap px-3 py-3 font-medium ${align === "right" ? "text-right" : "text-left"}`}
      scope="col"
    >
      <button
        className={`inline-flex items-center gap-1 rounded-xs hover:text-gray-1000 ${FOCUS_RING} ${
          active ? "font-semibold text-gray-1000" : "text-gray-900"
        }`}
        onClick={onClick}
        type="button"
      >
        <span>{label}</span>
        <SortIcon
          aria-hidden="true"
          className={`size-3 ${active ? "opacity-100" : "opacity-60"}`}
        />
      </button>
    </th>
  );
};

const TaskBreakdownSection = ({ modelResults }: { modelResults: EveModelResults }) => {
  const [taskMetric, setTaskMetric] = useState<TaskMetric>("resolved");
  const harnesses = rankedHarnesses(modelResults);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold text-gray-1000 text-xl" id="task-breakdown">
            Per-Task Breakdown
          </h2>
          <p className="mt-0.5 text-gray-900 text-xs">
            All {modelResults.taskMatrix.length} {modelResults.dataset.name} tasks ·{" "}
            {taskMetric === "resolved"
              ? `resolved out of ${modelResults.attempts} attempts`
              : taskMetric === "latency"
                ? "median duration per attempt"
                : "mean input / output tokens per attempt"}
          </p>
        </div>
        <div
          aria-label="Task metric"
          className="inline-flex rounded-lg border border-gray-400 p-0.5 text-xs"
          role="group"
        >
          {(
            [
              ["resolved", "Resolved"],
              ["latency", "Latency"],
              ["tokens", "Tokens"],
            ] as const
          ).map(([key, label]) => (
            <button
              aria-pressed={taskMetric === key}
              className={`rounded-md px-2.5 py-1 ${FOCUS_RING} ${
                taskMetric === key
                  ? "bg-gray-200 font-medium text-gray-1000"
                  : "text-gray-900 hover:text-gray-1000"
              }`}
              key={key}
              onClick={() => setTaskMetric(key)}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-gray-400 bg-background-100">
        <table className="w-full min-w-[640px] border-collapse text-left text-sm">
          <thead className="bg-gray-100 text-gray-900 text-xs">
            <tr>
              <th className="px-3.5 py-3 font-medium" scope="col">
                Task
              </th>
              {harnesses.map((h, index) => (
                <th
                  className="whitespace-nowrap px-3.5 py-3 text-right font-mono font-medium"
                  key={h.harness}
                  scope="col"
                >
                  <span className="inline-flex items-center justify-end gap-1.5">
                    <span
                      className="size-2 rounded-full"
                      style={{ background: harnessColor(h.harness, index) }}
                    />
                    {h.harness}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {modelResults.taskMatrix.map((row) => {
              const bestLatency = bestOf(
                harnesses.map((h) => row.cells[h.harness]?.latencyMs),
                "min",
              );
              const bestInput = bestOf(
                harnesses.map((h) => row.cells[h.harness]?.inputTokens),
                "min",
              );

              return (
                <tr className="border-gray-300 border-t hover:bg-gray-100/40" key={row.task}>
                  <td className="px-3.5 py-2.5 font-mono text-gray-1000 text-xs sm:text-sm">
                    {row.task}
                  </td>
                  {harnesses.map((h) => {
                    const cell = row.cells[h.harness];
                    if (!cell) {
                      return (
                        <td
                          className="px-3.5 py-2.5 text-right font-mono text-gray-900 text-xs"
                          key={h.harness}
                        >
                          —
                        </td>
                      );
                    }
                    if (taskMetric === "resolved") {
                      const ratio = cell.attempts > 0 ? cell.resolved / cell.attempts : 0;
                      const pillClass =
                        ratio === 1
                          ? "bg-green-200 text-green-900 font-semibold"
                          : ratio > 0
                            ? "bg-amber-200 text-amber-900 font-medium"
                            : "bg-gray-200 text-gray-900";
                      return (
                        <td className="px-3.5 py-2.5 text-right font-mono text-xs" key={h.harness}>
                          <span className={`inline-block rounded-md px-2 py-0.5 ${pillClass}`}>
                            {cell.resolved}/{cell.attempts}
                          </span>
                        </td>
                      );
                    }
                    if (taskMetric === "latency") {
                      const isBest = bestLatency != null && cell.latencyMs === bestLatency;
                      return (
                        <td
                          className={`whitespace-nowrap px-3.5 py-2.5 text-right font-mono text-xs ${
                            isBest ? "font-semibold text-green-900" : "text-gray-1000"
                          }`}
                          key={h.harness}
                        >
                          {formatDurationMs(cell.latencyMs)}
                        </td>
                      );
                    }
                    const isBest = bestInput != null && cell.inputTokens === bestInput;
                    return (
                      <td
                        className={`whitespace-nowrap px-3.5 py-2.5 text-right font-mono text-xs ${
                          isBest ? "font-semibold text-green-900" : "text-gray-1000"
                        }`}
                        key={h.harness}
                      >
                        {formatTokens(cell.inputTokens)} in{" "}
                        <span className="text-gray-900">
                          / {formatTokens(cell.outputTokens)} out
                        </span>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

const OverheadProfileGrid = ({ modelResults }: { modelResults: EveModelResults }) => {
  const harnesses = rankedHarnesses(modelResults);

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
      {harnesses.map((entry, index) => {
        const overhead = entry.overhead;
        const color = harnessColor(entry.harness, index);
        const topTools = (overhead?.topTools ?? []).slice(0, 5);
        const maxToolCount = topTools[0]?.count ?? 1;

        return (
          <div
            className="flex flex-col rounded-xl border border-gray-400 bg-background-100 p-4"
            key={entry.harness}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-2 font-mono font-semibold text-gray-1000 text-sm">
                <span className="size-2.5 shrink-0 rounded-full" style={{ background: color }} />
                <span className="truncate">{entry.harness}</span>
              </span>
              {entry.version ? (
                <span className="shrink-0 font-mono text-gray-900 text-xs">{entry.version}</span>
              ) : null}
            </div>

            <div className="mt-3 grid grid-cols-3 gap-2 border-gray-300 border-b pb-3 text-xs">
              <div>
                <div className="text-gray-900">Step 1</div>
                <div className="mt-0.5 font-mono font-medium text-gray-1000">
                  {formatTokens(overhead?.firstStepInputTokens ?? null)}
                </div>
              </div>
              <div>
                <div className="text-gray-900">Steps</div>
                <div className="mt-0.5 font-mono font-medium text-gray-1000">
                  {formatMedianCount(overhead?.modelStepsMedian ?? null)}
                </div>
              </div>
              <div>
                <div className="text-gray-900">Tools</div>
                <div className="mt-0.5 font-mono font-medium text-gray-1000">
                  {formatMedianCount(overhead?.toolCallsMedian ?? null)}
                </div>
              </div>
            </div>

            <div className="mt-3 space-y-2">
              <div className="text-gray-900 text-xs">Top tools ({entry.attempts} attempts)</div>
              {topTools.length > 0 ? (
                topTools.map((tool) => (
                  <div className="space-y-0.5" key={tool.name}>
                    <div className="flex items-center justify-between gap-2 font-mono text-xs">
                      <span className="truncate text-gray-1000">{tool.name}</span>
                      <span className="shrink-0 text-gray-900">{tool.count}</span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-200">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${Math.max(4, Math.round((tool.count / maxToolCount) * 100))}%`,
                          background: color,
                          opacity: 0.75,
                        }}
                      />
                    </div>
                  </div>
                ))
              ) : (
                <p className="text-gray-900 text-xs">No tool breakdown reported.</p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};

function formatLongDate(value: string | null): string {
  if (value === null) return "Not yet published";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "long",
    timeZone: "UTC",
  }).format(new Date(value));
}
