#!/usr/bin/env node

// Publishes one Authoring Benchmark workflow run to the private Blob store the
// nightly eval benchmark uses, with the same immutability guarantees (see
// scripts/eval-benchmark/publish.mjs). manifest.json is written last, so its
// presence tells ingest the run is complete:
//
//   authoring/runs/<github_run_id>/<run_attempt>/raw/<model_id>/...
//   authoring/runs/<github_run_id>/<run_attempt>/records.jsonl
//   authoring/runs/<github_run_id>/<run_attempt>/manifest.json
//
// Each model job uploads one artifact, downloaded to
// <artifacts-dir>/authoring-benchmark-<model_id>-<sha>/, holding:
//
//   meta.json                    { model_id, sha, eve_revision, treatment, runner_os }
//   <experiment>/<timestamp>/<case>/run-N/   agent-eval's results tree
//
// The manifest's `published_at` is when the run was first published (ISO 8601).
//
// Each record is one run of one case on one model, keyed by (github_run_id,
// run_attempt, model_id, case, run). Planned runs with no result, including
// every run of a model whose job uploaded nothing, become `missing` records so
// coverage stays honest. A metric that can't be read is `null`, never zero.
//
// Usage: node scripts/publish-results.mjs <artifacts-dir>
// Requires EVE_BENCHMARK_BLOB_READ_WRITE_TOKEN, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT,
// and the planned BENCHMARK_SHA, BENCHMARK_EVE_REVISION, BENCHMARK_TREATMENT,
// BENCHMARK_MODELS (JSON array of model ids), BENCHMARK_CASES (comma-separated),
// and BENCHMARK_RUNS.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  contentTypeOf,
  listFiles,
  mapLimit,
  putImmutable,
  vercelBlobStore,
} from "../../../scripts/eval-benchmark/publish.mjs";
import { findBenchmarkModel } from "../lib/benchmark-config.ts";
import { modelPricing, priceUsage } from "./cost.mjs";
import { analyzeRun, collectRuns } from "./run-analysis.mjs";

export const RECORD_SCHEMA_VERSION = 1;
const ARTIFACT_PREFIX = "authoring-benchmark-";
const UPLOAD_CONCURRENCY = 8;

/** Maps downloaded model artifacts onto planned models, rejecting anything unplanned. */
export function readModelArtifacts(plan, artifactsDir) {
  const found = new Map();
  for (const dir of artifactDirs(artifactsDir)) {
    const metaPath = join(dir, "meta.json");
    if (!existsSync(metaPath)) throw new Error(`${dir} has no meta.json.`);
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    for (const key of ["sha", "eve_revision", "treatment"]) {
      if (meta[key] !== plan[key])
        throw new Error(`${metaPath}: ${key} is "${meta[key]}", but the plan has "${plan[key]}".`);
    }
    if (!plan.models.includes(meta.model_id))
      throw new Error(`${metaPath}: model "${meta.model_id}" was not planned.`);
    if (found.has(meta.model_id))
      throw new Error(`${metaPath}: model "${meta.model_id}" uploaded more than one artifact.`);
    found.set(meta.model_id, { dir, meta });
  }
  return plan.models.map((modelId) => ({ modelId, ...found.get(modelId) }));
}

/**
 * One directory per downloaded artifact. actions/download-artifact unpacks a
 * pattern that matches a single artifact straight into `path` rather than an
 * `<artifact-name>/` subdirectory, so a `meta.json` at the root means the root
 * is that one artifact.
 */
function artifactDirs(artifactsDir) {
  if (!existsSync(artifactsDir)) return [];
  if (existsSync(join(artifactsDir, "meta.json"))) return [artifactsDir];
  return readdirSync(artifactsDir, { withFileTypes: true }).map((entry) => {
    if (!entry.isDirectory() || !entry.name.startsWith(ARTIFACT_PREFIX))
      throw new Error(
        `Unexpected entry "${entry.name}" in ${artifactsDir}; expected ${ARTIFACT_PREFIX}<model> directories.`,
      );
    return join(artifactsDir, entry.name);
  });
}

/** Derives one record per planned (model, case, run), in plan order. */
export function buildRecords({ plan, artifacts, githubRunId, runAttempt }) {
  const records = [];
  for (const { modelId, dir, meta } of artifacts) {
    const benchmark = findBenchmarkModel(modelId);
    const results = new Map();
    for (const runPath of dir === undefined ? [] : collectRuns(dir)) {
      const record = analyzeRun(runPath);
      const key = `${record.case}/${record.run}`;
      if (!plan.cases.includes(record.case))
        throw new Error(`${runPath}: case "${record.case}" was not planned.`);
      const run = Number(/^run-(\d+)$/u.exec(record.run)?.[1]);
      if (!(run >= 1 && run <= plan.runs))
        throw new Error(
          `${runPath}: "${record.run}" is outside the planned run-1..run-${plan.runs}.`,
        );
      if (results.has(key)) throw new Error(`${modelId} has more than one result for ${key}.`);
      results.set(key, record);
    }
    for (const caseId of plan.cases) {
      for (let run = 1; run <= plan.runs; run++) {
        const result = results.get(`${caseId}/run-${run}`);
        records.push({
          schema_version: RECORD_SCHEMA_VERSION,
          github_run_id: String(githubRunId),
          run_attempt: runAttempt,
          sha: plan.sha,
          eve_revision: plan.eve_revision,
          treatment: plan.treatment,
          model_id: modelId,
          model: benchmark.model,
          harness: benchmark.harness,
          runner_os: meta?.runner_os ?? null,
          case: caseId,
          run,
          ...(result === undefined
            ? { outcome: "missing" }
            : {
                raw_path: `raw/${modelId}/${relative(dir, result.path).replaceAll("\\", "/")}`,
                ...runMetrics(result, benchmark),
              }),
        });
      }
    }
  }
  return records;
}

function runMetrics(result, benchmark) {
  const pricing = modelPricing[benchmark.model];
  const usage = result.usage;
  return {
    outcome: result.status,
    duration_s: result.durationSeconds,
    agent_s: result.agentSeconds,
    setup_s: result.setupSeconds,
    turns: result.turns,
    tool_calls: result.toolCalls,
    commands: result.commands,
    usage:
      usage === null
        ? null
        : {
            input_tokens: usage.input,
            output_tokens: usage.output,
            reasoning_tokens: usage.reasoning,
            cache_read_tokens: usage.cacheRead,
            cache_write_tokens: usage.cacheWrite,
          },
    cost_usd: usage === null || pricing === undefined ? null : priceUsage(usage, pricing),
    docs_read: result.docsRead,
    docs_entry: result.docsEntry,
    registry_calls: result.registryCalls,
    stalls: result.stalls,
    grader_failures: result.failures,
    script_failures: result.scriptFailures,
  };
}

/**
 * @param {{ plan: any, artifactsDir: string, githubRunId: string, runAttempt: number, publishedAt: string, store: import("../../../scripts/eval-benchmark/publish.mjs").ImmutableStore }} input
 */
export async function publishResults({
  plan,
  artifactsDir,
  githubRunId,
  runAttempt,
  publishedAt,
  store,
}) {
  const artifacts = readModelArtifacts(plan, artifactsDir);
  const records = buildRecords({ plan, artifacts, githubRunId, runAttempt });
  const prefix = `authoring/runs/${githubRunId}/${runAttempt}`;

  const uploads = artifacts.flatMap(({ modelId, dir }) =>
    dir === undefined
      ? []
      : listFiles(dir).map((path) => ({
          pathname: `${prefix}/raw/${modelId}/${relative(dir, path).replaceAll("\\", "/")}`,
          path,
        })),
  );
  await mapLimit(uploads, UPLOAD_CONCURRENCY, ({ pathname, path }) =>
    putImmutable(store, pathname, readFileSync(path), contentTypeOf(path)),
  );

  const recordsBody = Buffer.from(records.map((record) => `${JSON.stringify(record)}\n`).join(""));
  await putImmutable(store, `${prefix}/records.jsonl`, recordsBody, "application/x-ndjson");
  const manifestPath = `${prefix}/manifest.json`;
  // A retry keeps the first publish time, so an identical re-run stays a no-op.
  const published = await store.read(manifestPath);
  const manifest = {
    schema_version: RECORD_SCHEMA_VERSION,
    github_run_id: String(githubRunId),
    run_attempt: runAttempt,
    published_at: published === null ? publishedAt : JSON.parse(published).published_at,
    sha: plan.sha,
    eve_revision: plan.eve_revision,
    treatment: plan.treatment,
    cases: plan.cases,
    runs: plan.runs,
    models: artifacts.map(({ modelId, dir }) => {
      const benchmark = findBenchmarkModel(modelId);
      return {
        model_id: modelId,
        model: benchmark.model,
        harness: benchmark.harness,
        uploaded: dir !== undefined,
      };
    }),
    files: {
      records: {
        path: "records.jsonl",
        schema_version: RECORD_SCHEMA_VERSION,
        count: records.length,
        sha256: createHash("sha256").update(recordsBody).digest("hex"),
      },
    },
  };
  await putImmutable(
    store,
    manifestPath,
    Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
    "application/json",
  );
  return { prefix, objects: uploads.length + 2, records: records.length };
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required to publish authoring benchmark results.`);
  return value;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [artifactsDir] = process.argv.slice(2);
  if (artifactsDir === undefined) {
    console.error("Usage: node scripts/publish-results.mjs <artifacts-dir>");
    process.exit(1);
  }
  const plan = {
    sha: requiredEnv("BENCHMARK_SHA"),
    eve_revision: requiredEnv("BENCHMARK_EVE_REVISION"),
    treatment: requiredEnv("BENCHMARK_TREATMENT"),
    models: JSON.parse(requiredEnv("BENCHMARK_MODELS")),
    cases: requiredEnv("BENCHMARK_CASES").split(","),
    runs: Number(requiredEnv("BENCHMARK_RUNS")),
  };
  if (!Number.isSafeInteger(plan.runs) || plan.runs < 1)
    throw new Error(
      `BENCHMARK_RUNS must be a positive integer, got "${process.env.BENCHMARK_RUNS}".`,
    );
  const result = await publishResults({
    plan,
    artifactsDir,
    githubRunId: requiredEnv("GITHUB_RUN_ID"),
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? "1"),
    publishedAt: new Date().toISOString(),
    store: await vercelBlobStore(requiredEnv("EVE_BENCHMARK_BLOB_READ_WRITE_TOKEN")),
  });
  console.error(
    `Published ${result.records} records and ${result.objects} objects to ${result.prefix}.`,
  );
}
