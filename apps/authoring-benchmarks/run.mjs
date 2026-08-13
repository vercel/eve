#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const appRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(appRoot, "../..");
const experimentsRoot = join(appRoot, "experiments");
const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    all: { type: "boolean" },
    base: { type: "string" },
    head: { type: "string" },
    dry: { type: "boolean" },
    runs: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  strict: true,
});

if (values.help) {
  usage();
  process.exit(0);
}
if (positionals.length > 1) throw new Error("Expected at most one <eval-name>.");
if (values.all && positionals.length > 0)
  throw new Error("--all cannot be combined with an eval name.");
if ((values.base === undefined) !== (values.head === undefined)) {
  throw new Error("--base and --head must be provided together.");
}
const runs = parseRuns(values.runs);
const selectedEval = positionals[0];
if (selectedEval !== undefined && !existsSync(join(appRoot, "evals", selectedEval, "CASE.ts"))) {
  throw new Error(`Unknown eval ${JSON.stringify(selectedEval)}.`);
}

const configuredRepository = process.env.EVE_BENCHMARK_REPOSITORY;
const repository =
  configuredRepository ?? git(repositoryRoot, ["remote", "get-url", "origin"]).trim();
const compare = values.base !== undefined;
const subjects = compare
  ? [
      resolveSubject(repository, values.base, "base", configuredRepository === undefined),
      resolveSubject(repository, values.head, "head", configuredRepository === undefined),
    ]
  : [resolveDefaultSubject(repository, configuredRepository)];

mkdirSync(join(appRoot, "results"), { recursive: true });
writeExperiments(subjects, runs);
const executable = join(appRoot, "node_modules/.bin/agent-eval");
const experimentNames = subjects.map((subject) => subject.label);
const args = values.dry ? ["status", ...experimentNames] : ["run", ...experimentNames, "--force"];

for (const subject of subjects) {
  console.log(`> ${subject.label}: ${subject.revision.slice(0, 12)}`);
}
const result = spawnSync(executable, args, {
  cwd: appRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    EVE_BENCHMARK_EVAL: selectedEval ?? "*",
  },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);

function resolveDefaultSubject(repository, configuredRepository) {
  const requestedRevision = process.env.EVE_BENCHMARK_REVISION;
  if (configuredRepository === undefined && requestedRevision === undefined) {
    if (git(repositoryRoot, ["status", "--porcelain", "--untracked-files=no"]).trim() !== "") {
      throw new Error(
        "The local checkout has tracked changes. Commit them or select a subject with EVE_BENCHMARK_REPOSITORY and EVE_BENCHMARK_REVISION.",
      );
    }
    const revision = git(repositoryRoot, ["rev-parse", "HEAD"]).trim();
    assertRemoteTip(repository, revision);
    return { label: "current", repository, revision };
  }
  return resolveSubject(repository, requestedRevision ?? "origin/main", "current", false);
}

function resolveSubject(repository, requestedRevision, label, allowLocalRevision) {
  if (allowLocalRevision && requestedRevision === "HEAD") {
    const revision = git(repositoryRoot, ["rev-parse", "HEAD"]).trim();
    assertRemoteTip(repository, revision);
    return { label, repository, revision };
  }
  return { label, repository, revision: resolveRevision(repository, requestedRevision) };
}

function resolveRevision(repository, revision) {
  if (/^[0-9a-f]{40}$/iu.test(revision)) return revision.toLowerCase();
  const normalized = revision.startsWith("origin/") ? revision.slice("origin/".length) : revision;
  const output = execFileSync(
    "git",
    [
      "ls-remote",
      repository,
      normalized,
      `refs/heads/${normalized}`,
      `refs/tags/${normalized}^{}`,
      `refs/tags/${normalized}`,
    ],
    { encoding: "utf8" },
  );
  const resolved = output.match(/^[0-9a-f]{40}/imu)?.[0];
  if (resolved === undefined)
    throw new Error(`Could not resolve revision ${JSON.stringify(revision)}.`);
  return resolved.toLowerCase();
}

function assertRemoteTip(repository, revision) {
  const remoteRefs = execFileSync("git", ["ls-remote", repository], { encoding: "utf8" });
  if (!remoteRefs.includes(revision)) {
    throw new Error(`Revision ${revision.slice(0, 12)} is not reachable from ${repository}.`);
  }
}

function writeExperiments(subjects, runs) {
  rmSync(experimentsRoot, { recursive: true, force: true });
  mkdirSync(experimentsRoot, { recursive: true });
  for (const subject of subjects) {
    writeFileSync(
      join(experimentsRoot, `${subject.label}.ts`),
      `import { authoringExperiment } from "../lib/experiment.js";\n\n` +
        `export default authoringExperiment({\n` +
        `  repository: ${JSON.stringify(subject.repository)},\n` +
        `  revision: ${JSON.stringify(subject.revision)},\n` +
        `  runs: ${runs},\n` +
        `});\n`,
    );
  }
}

function parseRuns(value) {
  if (value === undefined) return 1;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error("--runs must be a positive integer.");
  return parsed;
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function usage() {
  console.log(`Usage:
  pnpm benchmark:authoring [eval-name] [--all] [--runs N] [--dry]
  pnpm benchmark:authoring [eval-name] --base <revision> --head <revision> [--runs N] [--dry]`);
}
