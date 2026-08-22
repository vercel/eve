#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { findBenchmarkModel, parseAuthoringTreatment } from "./lib/benchmark-config.ts";
import {
  prepareFixtures,
  resetExperiments,
  writeExperiment,
  writeSubjectArchives,
} from "./lib/experiment-files.mjs";
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
    model: { type: "string", default: "claude-sonnet-5" },
    treatment: { type: "string", default: "guided" },
    verbose: { type: "boolean" },
    // The runner discards a run it decides failed for infrastructure reasons,
    // which throws away the transcript you need to tell a real stall from a
    // misjudged one.
    "keep-failures": { type: "boolean" },
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
const benchmark = findBenchmarkModel(values.model);
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

prepareFixtures(evalsRoot, selectedEval === undefined ? undefined : [selectedEval]);
mkdirSync(join(appRoot, "results"), { recursive: true });
writeExperiments(subjects, runs, benchmark, treatment, values.verbose ?? false);
const executable = join(appRoot, "node_modules/.bin/agent-eval");
const experimentNames = subjects.map((subject) => subject.label);
const args = values.dry
  ? ["status", ...experimentNames]
  : ["run", ...experimentNames, "--force", ...(values["keep-failures"] ? ["--ack-failures"] : [])];

for (const subject of subjects) console.log(`> ${subject.label}: ${subject.description}`);
const result = spawnSync(executable, args, {
  cwd: appRoot,
  stdio: "inherit",
  env: { ...process.env, EVE_BENCHMARK_EVAL: selectedEval ?? "*" },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);

function writeExperiments(subjects, runs, benchmark, treatment, verbose) {
  resetExperiments(experimentsRoot);
  for (const subject of subjects) {
    const { archiveName, dependencyArchiveName } = writeSubjectArchives(
      experimentsRoot,
      subject,
      subject.label,
    );
    writeExperiment(experimentsRoot, subject.label, {
      archiveName,
      dependencyArchiveName,
      digest: subject.digest,
      dependencyDigest: subject.dependencyDigest,
      runs,
      benchmark,
      treatment,
      verbose,
    });
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
  pnpm benchmark [eval-name] [--model <id>] [--runs N] [--treatment baseline|guided] [--dry] [--verbose] [--keep-failures]
  pnpm benchmark [eval-name] --base <revision> [--head <revision>] [--model <id>] [--runs N] [--treatment baseline|guided] [--dry]`);
}
