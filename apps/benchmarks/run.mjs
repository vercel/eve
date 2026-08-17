#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { parseAuthoringTreatment } from "./lib/benchmark-config.ts";
import { revisionSubject, workingTreeSubject } from "./lib/source.mjs";

const appRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(appRoot, "../..");
const evalsRoot = join(appRoot, "evals");
const experimentsRoot = join(appRoot, "experiments");
const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    base: { type: "string" },
    head: { type: "string" },
    dry: { type: "boolean" },
    runs: { type: "string" },
    treatment: { type: "string", default: "guided" },
    verbose: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
  strict: true,
});

if (values.help) {
  usage();
  process.exit(0);
}
if (positionals.length > 1) throw new Error("Expected at most one <eval-name>.");
if (values.head !== undefined && values.base === undefined) {
  throw new Error("--head requires --base.");
}
const runs = parseRuns(values.runs);
const selectedEval = positionals[0];
const treatment = parseAuthoringTreatment(values.treatment);
if (values.verbose && (selectedEval === undefined || runs !== 1 || values.base !== undefined)) {
  throw new Error("--verbose requires one eval, one run, and no revision comparison.");
}
if (selectedEval !== undefined && !existsSync(join(evalsRoot, selectedEval, "CASE.ts"))) {
  throw new Error(`Unknown eval ${JSON.stringify(selectedEval)}.`);
}

const workingTree = () => workingTreeSubject(repositoryRoot);
const subjects =
  values.base === undefined
    ? [workingTree()]
    : [
        revisionSubject(repositoryRoot, values.base, "base"),
        values.head === undefined
          ? { ...workingTree(), label: "head" }
          : revisionSubject(repositoryRoot, values.head, "head"),
      ];

prepareFixtures();
mkdirSync(join(appRoot, "results"), { recursive: true });
writeExperiments(subjects, runs, treatment, values.verbose ?? false);
const executable = join(appRoot, "node_modules/.bin/agent-eval");
const experimentNames = subjects.map((subject) => subject.label);
const args = values.dry ? ["status", ...experimentNames] : ["run", ...experimentNames, "--force"];

for (const subject of subjects) console.log(`> ${subject.label}: ${subject.description}`);
const result = spawnSync(executable, args, {
  cwd: appRoot,
  stdio: "inherit",
  env: { ...process.env, EVE_BENCHMARK_EVAL: selectedEval ?? "*" },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);

function prepareFixtures() {
  const names = selectedEval === undefined ? fixtureNames() : [selectedEval];
  for (const name of names) {
    const fixtureRoot = join(evalsRoot, name);
    writeFileSync(join(fixtureRoot, "PROMPT.md"), "");
    writeFileSync(
      join(fixtureRoot, "package.json"),
      `${JSON.stringify({ name: `eve-authoring-${name}`, private: true, type: "module" }, null, 2)}\n`,
    );
  }
}

function fixtureNames() {
  return readdirSync(evalsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(evalsRoot, entry.name, "CASE.ts")))
    .map((entry) => entry.name);
}

function writeExperiments(subjects, runs, treatment, verbose) {
  rmSync(experimentsRoot, { recursive: true, force: true });
  mkdirSync(experimentsRoot, { recursive: true });
  for (const subject of subjects) {
    const archivePath = join(experimentsRoot, `${subject.label}.source.tar.gz`);
    writeFileSync(archivePath, subject.archive);
    writeFileSync(
      join(experimentsRoot, `${subject.label}.ts`),
      `import { readFileSync } from "node:fs";\n` +
        `import { authoringExperiment } from "../lib/experiment.js";\n\n` +
        `export default authoringExperiment({\n` +
        `  archive: readFileSync(new URL(${JSON.stringify(`./${subject.label}.source.tar.gz`)}, import.meta.url)),\n` +
        `  digest: ${JSON.stringify(subject.digest)},\n` +
        `  dependencyDigest: ${JSON.stringify(subject.dependencyDigest)},\n` +
        `  runs: ${runs},\n` +
        `  treatment: ${JSON.stringify(treatment)},\n` +
        `  verbose: ${verbose},\n` +
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

function usage() {
  console.log(`Usage:
  pnpm benchmark [eval-name] [--runs N] [--treatment baseline|guided] [--dry] [--verbose]
  pnpm benchmark [eval-name] --base <revision> [--head <revision>] [--runs N] [--treatment baseline|guided] [--dry]`);
}
