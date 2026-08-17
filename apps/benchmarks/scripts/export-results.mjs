#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  authoringTreatments,
  publishedBenchmark,
  publishedExperimentId,
} from "../lib/benchmark-config.ts";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(appRoot, "../..");
const evalsRoot = join(appRoot, "evals");
const resultsRoot = join(appRoot, "results");
const outputPath = join(repositoryRoot, "apps/docs/lib/evals/benchmark-results.json");
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    revision: { type: "string" },
    output: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  strict: true,
});

if (values.help) {
  console.log("Usage: node scripts/export-results.mjs --revision <full-sha> [--output <path>]");
  process.exit(0);
}
if (values.revision === undefined || !/^[0-9a-f]{40}$/u.test(values.revision)) {
  throw new Error("--revision must be a full 40-character Git commit SHA.");
}

const caseIds = canonicalCaseIds();
const experimentIds = authoringTreatments.map(publishedExperimentId);
const stale = staleCells(experimentIds);
const results = [];

for (const treatment of authoringTreatments) {
  const experimentId = publishedExperimentId(treatment);
  for (const caseId of caseIds) {
    const staleStatus = stale.get(experimentId);
    const status = staleStatus?.changed.has(caseId)
      ? "stale"
      : staleStatus?.new.has(caseId)
        ? "missing"
        : undefined;
    const measured = latestValidResult(experimentId, caseId);
    if (status !== undefined || measured === undefined) {
      results.push({ experimentId, caseId, status: status ?? "missing" });
      continue;
    }
    results.push({ experimentId, caseId, status: "current", ...measured });
  }
}

const output = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  suite: {
    eveRevision: values.revision,
    caseFingerprint: caseFingerprint(caseIds),
    caseCount: caseIds.length,
    runsPerCell: publishedBenchmark.runs,
  },
  experiments: authoringTreatments.map((treatment) => ({
    id: publishedExperimentId(treatment),
    groupId: publishedBenchmark.groupId,
    model: publishedBenchmark.model,
    modelDisplayName: publishedBenchmark.modelDisplayName,
    harness: publishedBenchmark.harness,
    treatment,
  })),
  results,
};

const destination =
  values.output === undefined ? outputPath : resolve(process.cwd(), values.output);
mkdirSync(dirname(destination), { recursive: true });
writeFileSync(destination, `${JSON.stringify(output, null, 2)}\n`);
console.log(`Exported ${results.length} benchmark cells to ${destination}`);

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

function canonicalCaseIds() {
  return readdirSync(evalsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(evalsRoot, entry.name, "CASE.ts")))
    .map((entry) => entry.name)
    .sort();
}

function staleCells(experimentIds) {
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
    };
  }
  return undefined;
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
