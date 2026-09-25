#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  countToolInvocations,
  extractRunUsage,
  modelPricing,
  priceUsage,
  tokenConsumption,
} from "./cost.mjs";
import {
  authoringTreatments,
  benchmarkModels,
  findPublishedBenchmarkModel,
  publishedBenchmark,
  publishedBenchmarkModels,
  publishedExperimentId,
  harnessId,
} from "../lib/benchmark-config.ts";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(appRoot, "../..");
const evalsRoot = join(appRoot, "evals");
const resultsRoot = join(appRoot, "results");
const experimentsRoot = join(appRoot, "experiments");
const outputPath = join(repositoryRoot, "apps/docs/lib/evals/benchmark-results.json");
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    revision: { type: "string" },
    output: { type: "string" },
    models: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  strict: true,
});

if (values.help) {
  console.log(
    "Usage: node scripts/export-results.mjs --revision <full-sha> [--models <id,...>] [--output <path>]",
  );
  process.exit(0);
}
if (values.revision === undefined || !/^[0-9a-f]{40}$/u.test(values.revision)) {
  throw new Error("--revision must be a full 40-character Git commit SHA.");
}

const caseIds = [...publishedBenchmark.caseIds];
const benchmarks = selectedBenchmarks(values.models);
const experimentIds = benchmarks.flatMap((benchmark) =>
  authoringTreatments.map((treatment) => publishedExperimentId(benchmark, treatment)),
);
const stale = staleCells(experimentIds);
const previous = readPublishedResults();
const previousResults = readPreviousResults(previous);
const results = [];

for (const benchmark of benchmarks) {
  for (const treatment of authoringTreatments) {
    const experimentId = publishedExperimentId(benchmark, treatment);
    for (const caseId of caseIds) {
      const staleStatus = stale.get(experimentId);
      const status = staleStatus?.changed.has(caseId)
        ? "stale"
        : staleStatus?.new.has(caseId)
          ? "missing"
          : undefined;
      const measured = latestValidResult(experimentId, caseId);
      if (measured === undefined) {
        results.push({ experimentId, caseId, status: "missing" });
        continue;
      }
      const { summaryPath, ...result } = measured;
      results.push({
        experimentId,
        caseId,
        status: status ?? "current",
        ...result,
        ...meanRunMetrics(summaryPath, benchmark.model, benchmark.harness),
      });
    }
  }
}

const experiments = benchmarks.flatMap((benchmark) =>
  authoringTreatments.map((treatment) => ({
    id: publishedExperimentId(benchmark, treatment),
    groupId: `${benchmark.id}-${harnessId(benchmark.harness)}`,
    model: benchmark.model,
    modelDisplayName: benchmark.displayName,
    harness: benchmark.harness,
    treatment,
  })),
);
const completeCurrentExperimentIds = new Set(
  experiments
    .filter((experiment) =>
      caseIds.every((caseId) =>
        results.some(
          (result) =>
            result.experimentId === experiment.id &&
            result.caseId === caseId &&
            result.status === "current",
        ),
      ),
    )
    .map((experiment) => experiment.id),
);
const published = experiments.map((experiment) => {
  if (completeCurrentExperimentIds.has(experiment.id)) {
    return {
      experiment,
      results: results.filter((result) => result.experimentId === experiment.id),
    };
  }
  const previousExperiment = previous?.experiments.find(
    (candidate) =>
      candidate.model === experiment.model && candidate.treatment === experiment.treatment,
  );
  return {
    experiment: previousExperiment ?? experiment,
    results: previousExperiment
      ? previous.results.filter((result) => result.experimentId === previousExperiment.id)
      : results.filter((result) => result.experimentId === experiment.id),
  };
});
const output = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  suite: {
    eveRevision: values.revision,
    caseFingerprint: caseFingerprint(caseIds),
    caseCount: caseIds.length,
    runsPerCell: publishedBenchmark.runs,
  },
  experiments: published.map((entry) => entry.experiment),
  results: published.flatMap((entry) => entry.results),
  ...(previousResults.length === 0 ? {} : { previouslyMeasured: previousResults }),
};

const destination =
  values.output === undefined ? outputPath : resolve(process.cwd(), values.output);
mkdirSync(dirname(destination), { recursive: true });
writeFileSync(destination, `${JSON.stringify(output, null, 2)}\n`);
console.log(`Exported ${results.length} benchmark cells to ${destination}`);

function readPublishedResults() {
  const destination =
    values.output === undefined ? outputPath : resolve(process.cwd(), values.output);
  if (!existsSync(destination)) return undefined;
  return JSON.parse(readFileSync(destination, "utf8"));
}

function readPreviousResults(previous) {
  if (previous === undefined) return [];
  const supersededExperimentIds = new Set(
    benchmarkModels
      .filter((benchmark) => benchmark.support === "superseded")
      .flatMap((benchmark) =>
        authoringTreatments.map((treatment) => publishedExperimentId(benchmark, treatment)),
      ),
  );
  const supersededExperiments = (previous.experiments ?? []).filter((experiment) =>
    supersededExperimentIds.has(experiment.id),
  );
  const archivedExperimentIds = new Set(supersededExperiments.map((experiment) => experiment.id));
  const supersededResults = (previous.results ?? []).filter((result) =>
    archivedExperimentIds.has(result.experimentId),
  );
  const retained = (previous.previouslyMeasured ?? [])
    .filter(
      (measurement) => Array.isArray(measurement.experiments) && Array.isArray(measurement.results),
    )
    .map((measurement) => {
      const experiments = measurement.experiments.filter((experiment) =>
        supersededExperimentIds.has(experiment.id),
      );
      const experimentIds = new Set(experiments.map((experiment) => experiment.id));
      return {
        ...measurement,
        experiments,
        results: measurement.results.filter((result) => experimentIds.has(result.experimentId)),
      };
    })
    .filter((measurement) => measurement.experiments.length > 0);
  if (supersededExperiments.length === 0) return retained;

  return [
    ...retained,
    {
      suite: previous.suite,
      experiments: supersededExperiments,
      results: supersededResults,
    },
  ];
}

function selectedBenchmarks(value) {
  if (value === undefined) return publishedBenchmarkModels;
  return value.split(",").map((model) => findPublishedBenchmarkModel(model));
}

function caseFingerprint(caseIds) {
  const hash = createHash("sha256");
  for (const caseId of caseIds) {
    const caseRoot = join(evalsRoot, caseId);
    for (const path of findFiles(caseRoot).sort()) {
      const relativePath = path.slice(caseRoot.length + 1);
      if (relativePath === "PROMPT.md" || relativePath === "package.json") continue;
      hash.update(caseId).update("\0").update(relativePath).update("\0");
      hash.update(readFileSync(path)).update("\0");
    }
  }
  return hash.digest("hex");
}

function staleCells(experimentIds) {
  if (!existsSync(experimentsRoot)) return new Map();
  const executable = join(appRoot, "node_modules/.bin/agent-eval");
  const raw = execFileSync(executable, ["status", ...experimentIds, "--json"], {
    cwd: appRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const parsed = JSON.parse(raw);
  const work = Array.isArray(parsed.work) ? parsed.work : [];
  return new Map(
    work.map((entry) => [
      entry.experiment,
      {
        new: new Set(Array.isArray(entry.new) ? entry.new : []),
        changed: new Set(Array.isArray(entry.changed) ? entry.changed : []),
      },
    ]),
  );
}

function latestValidResult(experimentId, caseId) {
  const experimentRoot = join(resultsRoot, experimentId);
  if (!existsSync(experimentRoot)) return undefined;
  const summaries = findFiles(experimentRoot, "summary.json")
    .filter((path) => path.split("/").includes(caseId))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);

  for (const summaryPath of summaries) {
    const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
    if (summary.valid === false) continue;
    if (!Number.isFinite(summary.totalRuns) || summary.totalRuns < 1) continue;
    if (!Number.isFinite(summary.passedRuns) || !Number.isFinite(summary.meanDuration)) continue;
    return {
      passedRuns: summary.passedRuns,
      validRuns: summary.totalRuns,
      meanDurationMs: Math.round(summary.meanDuration * 1000),
      measuredAt: statSync(summaryPath).mtime.toISOString(),
      summaryPath,
    };
  }
  return undefined;
}

function meanRunMetrics(summaryPath, model, harness) {
  const performanceRuns = runMetrics(summaryPath, harness);
  const performanceUsage = performanceRuns.flatMap((run) =>
    run.usage === null ? [] : [run.usage],
  );
  const result = {};
  const pricing = modelPricing[model];
  if (pricing !== undefined && performanceUsage.length > 0) {
    result.meanEstimatedListCostUsd = mean(
      performanceUsage.map((value) => priceUsage(value, pricing)),
    );
  }
  if (performanceUsage.length > 0) {
    result.meanTokenConsumption = mean(performanceUsage.map(tokenConsumption));
  }
  if (performanceRuns.length > 0) {
    result.meanToolInvocationCount = mean(performanceRuns.map((run) => run.toolInvocations));
  }
  return result;
}

function runMetrics(summaryPath, harness) {
  return readdirSync(dirname(summaryPath), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^run-\d+$/u.test(entry.name))
    .flatMap((entry) => {
      const transcriptPath = join(dirname(summaryPath), entry.name, "transcript-raw.jsonl");
      if (!existsSync(transcriptPath)) return [];
      const raw = readFileSync(transcriptPath, "utf8");
      return [{ usage: extractRunUsage(raw, harness), toolInvocations: countToolInvocations(raw) }];
    });
}

function mean(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function findFiles(root, fileName) {
  const matches = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) matches.push(...findFiles(path, fileName));
    else if (fileName === undefined || entry.name === fileName) matches.push(path);
  }
  return matches;
}
