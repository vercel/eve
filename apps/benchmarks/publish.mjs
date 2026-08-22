#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  authoringTreatments,
  findPublishedBenchmarkModel,
  publishedBenchmark,
  publishedBenchmarkModels,
  publishedExperimentId,
} from "./lib/benchmark-config.ts";
import {
  prepareFixtures,
  resetExperiments,
  writeExperiment,
  writeSubjectArchives,
} from "./lib/experiment-files.mjs";
import { revisionSubject } from "./lib/source.mjs";

const appRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(appRoot, "../..");
const evalsRoot = join(appRoot, "evals");
const experimentsRoot = join(appRoot, "experiments");
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "allow-dirty": { type: "boolean" },
    dry: { type: "boolean" },
    force: { type: "boolean" },
    revision: { type: "string", default: "origin/main" },
    models: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  strict: true,
});

if (values.help) {
  console.log(`Usage:
  pnpm benchmark:publish [--revision origin/main] [--models <id,...>] [--dry]
  pnpm benchmark:publish [--revision <revision>] [--models <id,...>] [--force] [--allow-dirty]`);
  process.exit(0);
}
if (values.dry && values.force) throw new Error("--dry and --force cannot be combined.");
if (!values.dry && !values["allow-dirty"] && !checkCleanWorkingTree()) process.exit(1);
if (values["allow-dirty"]) {
  console.warn(
    "Warning: publishing from a dirty working tree is not reproducible from committed source.",
  );
}

const revision = git(["rev-parse", "--verify", `${values.revision}^{commit}`]).trim();
const subject = revisionSubject(repositoryRoot, revision, "published");
const benchmarks = selectedBenchmarks(values.models);
const experimentNames = benchmarks.flatMap((benchmark) =>
  authoringTreatments.map((treatment) => publishedExperimentId(benchmark, treatment)),
);

prepareFixtures(evalsRoot);
writeExperiments(subject, revision, benchmarks);

console.log(`> eve revision: ${revision}`);
console.log(
  `> models: ${benchmarks.map((benchmark) => `${benchmark.displayName} through ${benchmark.harness}`).join(", ")}`,
);
console.log(`> treatments: ${authoringTreatments.join(", ")}`);
console.log(`> runs per cell: ${publishedBenchmark.runs}`);

const executable = join(appRoot, "node_modules/.bin/agent-eval");
if (values.dry) {
  runAgentEval(["status", ...experimentNames]);
  process.exit(0);
}

console.log(`> running ${experimentNames.length} experiments concurrently`);
runAgentEval(["run", ...experimentNames, ...(values.force ? ["--force"] : [])], {}, false);

const pending = benchmarkStatus();
if (pending.totalRun > 0) {
  console.error(
    `\nCannot publish: ${pending.totalRun} benchmark cell(s) still need a valid result.`,
  );
  console.error("Fix any infrastructure failures, then run pnpm benchmark:publish again.");
  process.exit(1);
}

const exported = spawnSync(
  process.execPath,
  [join(appRoot, "scripts/export-results.mjs"), "--revision", revision],
  { cwd: appRoot, stdio: "inherit", env: process.env },
);
if (exported.error) throw exported.error;
process.exit(exported.status ?? 1);

function runAgentEval(args, extraEnv = {}, exitOnFailure = true) {
  const result = spawnSync(executable, args, {
    cwd: appRoot,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
  if (result.error) throw result.error;
  if (exitOnFailure && result.status !== 0) process.exit(result.status ?? 1);
  return result.status ?? 1;
}

function benchmarkStatus() {
  const result = spawnSync(executable, ["status", ...experimentNames, "--json"], {
    cwd: appRoot,
    encoding: "utf8",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return JSON.parse(result.stdout);
}

function checkCleanWorkingTree() {
  const entries = git([
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    ".",
    ":!pnpm-lock.yaml",
  ])
    .trimEnd()
    .split("\n")
    .filter(Boolean);
  if (entries.length === 0) return true;

  const shown = entries.slice(0, 12);
  console.error("Cannot publish canonical benchmark results from a dirty working tree.\n");
  console.error("Blocking changes:");
  for (const entry of shown) console.error(`  ${entry}`);
  if (entries.length > shown.length) {
    console.error(`  … and ${entries.length - shown.length} more`);
  }
  console.error(`
Publishing records results against committed source so another run can reproduce them.
Commit, stash, or remove these changes, then run:

  pnpm benchmark:publish

To bypass this check for a local run:

  pnpm benchmark:publish --allow-dirty

To inspect pending benchmark cells without publishing:

  pnpm benchmark:publish --dry`);
  return false;
}

function writeExperiments(subject, revision, benchmarks) {
  resetExperiments(experimentsRoot);
  const { archiveName, dependencyArchiveName } = writeSubjectArchives(
    experimentsRoot,
    subject,
    `published-${revision.slice(0, 12)}`,
  );

  for (const benchmark of benchmarks) {
    for (const treatment of authoringTreatments) {
      writeExperiment(experimentsRoot, publishedExperimentId(benchmark, treatment), {
        archiveName,
        dependencyArchiveName,
        digest: subject.digest,
        dependencyDigest: subject.dependencyDigest,
        runs: publishedBenchmark.runs,
        evals: publishedBenchmark.caseIds,
        benchmark,
        treatment,
      });
    }
  }
}

function selectedBenchmarks(value) {
  if (value === undefined) return publishedBenchmarkModels;
  return value.split(",").map((model) => findPublishedBenchmarkModel(model));
}

function git(args) {
  return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" });
}
