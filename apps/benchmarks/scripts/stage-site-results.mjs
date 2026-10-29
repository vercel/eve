#!/usr/bin/env node

// Stages a full Authoring Benchmark workflow run for scripts/export-results.mjs,
// which refreshes eve.dev/benchmarks. Each benchmark job uploads one artifact
// per model and treatment, downloaded to <artifacts-dir>/<artifact-name>/:
//
//   meta.json                    { model_id, sha, eve_revision, treatment, runner_os }
//   <experiment>/<timestamp>/<case>/run-N/   agent-eval's results tree
//
// The exporter reads results/<published experiment id>/, so each artifact's
// results tree is copied there. Artifacts from another commit or eve package,
// or for a model outside the published set, are rejected. A missing model or
// treatment is left out; the exporter keeps that row's previous measurement.
//
// Usage: node scripts/stage-site-results.mjs <artifacts-dir>
// Requires BENCHMARK_SHA and BENCHMARK_EVE_REVISION.

import { cpSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  authoringTreatments,
  findPublishedBenchmarkModel,
  parseAuthoringTreatment,
  publishedBenchmarkModels,
  publishedExperimentId,
} from "../lib/benchmark-config.ts";

/** Copies each artifact's results to results/<experiment id>/ and returns the staged ids. */
export function stageSiteResults({ plan, artifactsDir, resultsRoot }) {
  const staged = new Set();
  for (const dir of artifactDirs(artifactsDir)) {
    const metaPath = join(dir, "meta.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    for (const key of ["sha", "eve_revision"]) {
      if (meta[key] !== plan[key])
        throw new Error(`${metaPath}: ${key} is "${meta[key]}", but the plan has "${plan[key]}".`);
    }
    const benchmark = findPublishedBenchmarkModel(meta.model_id);
    const experimentId = publishedExperimentId(benchmark, parseAuthoringTreatment(meta.treatment));
    if (staged.has(experimentId))
      throw new Error(`${metaPath}: ${experimentId} uploaded more than one artifact.`);
    staged.add(experimentId);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      cpSync(join(dir, entry.name), join(resultsRoot, experimentId), {
        recursive: true,
        preserveTimestamps: true,
      });
    }
  }
  const missing = publishedBenchmarkModels
    .flatMap((benchmark) =>
      authoringTreatments.map((treatment) => publishedExperimentId(benchmark, treatment)),
    )
    .filter((experimentId) => !staged.has(experimentId));
  return { staged: [...staged], missing };
}

/**
 * One directory per downloaded artifact. actions/download-artifact unpacks a
 * pattern that matches a single artifact straight into `path`, so a
 * `meta.json` at the root means the root is that one artifact.
 */
function artifactDirs(artifactsDir) {
  if (!existsSync(artifactsDir)) return [];
  if (existsSync(join(artifactsDir, "meta.json"))) return [artifactsDir];
  return readdirSync(artifactsDir, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && existsSync(join(artifactsDir, entry.name, "meta.json")),
    )
    .map((entry) => join(artifactsDir, entry.name));
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required to stage site benchmark results.`);
  return value;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [artifactsDir] = process.argv.slice(2);
  if (artifactsDir === undefined) {
    console.error("Usage: node scripts/stage-site-results.mjs <artifacts-dir>");
    process.exit(1);
  }
  const { staged, missing } = stageSiteResults({
    plan: {
      sha: requiredEnv("BENCHMARK_SHA"),
      eve_revision: requiredEnv("BENCHMARK_EVE_REVISION"),
    },
    artifactsDir,
    resultsRoot: join(dirname(fileURLToPath(import.meta.url)), "../results"),
  });
  console.log(`Staged ${staged.length} experiment(s): ${staged.join(", ")}`);
  for (const experimentId of missing) {
    console.log(
      `::warning::${experimentId} uploaded no results; eve.dev/benchmarks keeps its previous measurement.`,
    );
  }
}
