#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  findBenchmarkModel,
  parseAuthoringTreatment,
  publishedBenchmark,
  selectBenchmarkModels,
} from "./lib/benchmark-config.ts";
import { prepareFixtures, resetExperiments, writeExperiment } from "./lib/experiment-files.mjs";
import { runPool } from "./lib/pool.mjs";
import { canarySubject } from "./lib/source.mjs";

const appRoot = dirname(fileURLToPath(import.meta.url));
const evalsRoot = join(appRoot, "evals");
const experimentsRoot = join(appRoot, "experiments");
const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    canary: { type: "string", default: "main" },
    dry: { type: "boolean" },
    runs: { type: "string" },
    model: { type: "string" },
    models: { type: "string" },
    concurrency: { type: "string" },
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
if (values.model !== undefined && values.models !== undefined) {
  throw new Error("Pass either --model or --models, not both.");
}
if (values.concurrency !== undefined && values.models === undefined) {
  throw new Error("--concurrency requires --models.");
}
const runs = parseRuns(values.runs);
const selectedEval = positionals[0];
const treatment = parseAuthoringTreatment(values.treatment);
const benchmarks =
  values.models === undefined
    ? [findBenchmarkModel(values.model ?? "claude-sonnet-5")]
    : selectBenchmarkModels(values.models);
const concurrency = parsePositiveInteger(values.concurrency ?? "1", "--concurrency");
if (values.verbose && (selectedEval === undefined || runs !== 1 || benchmarks.length !== 1)) {
  throw new Error("--verbose requires one eval, one run, and one model.");
}
if (selectedEval !== undefined && !existsSync(join(evalsRoot, selectedEval, "CASE.ts"))) {
  throw new Error(`Unknown eval ${JSON.stringify(selectedEval)}.`);
}

const subject = canarySubject(values.canary, "current");
await prepareFixtures(
  evalsRoot,
  subject,
  selectedEval === undefined ? publishedBenchmark.caseIds : [selectedEval],
);
const resultsRoot = join(appRoot, "results");
mkdirSync(resultsRoot, { recursive: true });
// One experiment per model, so separate agent-eval processes never share a
// config or results directory. A single model keeps the historical name.
const experiments = benchmarks.map((benchmark) => ({
  benchmark,
  name: benchmarks.length === 1 ? subject.label : `${subject.label}--${benchmark.id}`,
}));
writeExperiments(experiments, runs, treatment, values.verbose ?? false);
const executable = join(appRoot, "node_modules/.bin/agent-eval");
const env =
  selectedEval === undefined ? process.env : { ...process.env, EVE_BENCHMARK_EVAL: selectedEval };
const runArgs = (name) => [
  "run",
  name,
  "--force",
  ...(values["keep-failures"] ? ["--ack-failures"] : []),
];

console.log(`> ${subject.label}: ${subject.description}`);
if (values.dry || experiments.length === 1) {
  const names = experiments.map((experiment) => experiment.name);
  const args = values.dry ? ["status", ...names] : runArgs(names[0]);
  const result = spawnSync(executable, args, { cwd: appRoot, stdio: "inherit", env });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

const logsRoot = join(resultsRoot, "logs");
mkdirSync(logsRoot, { recursive: true });
console.log(
  `> running ${experiments.length} models, ${concurrency} at a time, ${runs} run(s) each; logs in ${logsRoot}`,
);
const outcomes = await runPool(experiments, concurrency, ({ name }) => {
  const logPath = join(logsRoot, `${name}.log`);
  console.log(`  started  ${name}`);
  return runLogged(runArgs(name), logPath).then((status) => {
    console.log(`  ${status === 0 ? "finished" : `failed (${status})`} ${name}`);
    return status;
  });
});
const failed = experiments.filter(
  (_, index) => outcomes[index].status === "rejected" || outcomes[index].value !== 0,
);
console.log(
  `> ${experiments.length - failed.length}/${experiments.length} models finished cleanly`,
);
for (const { name } of failed) console.log(`  see ${join(logsRoot, `${name}.log`)}`);
process.exit(failed.length === 0 ? 0 : 1);

function runLogged(args, logPath) {
  return new Promise((resolve, reject) => {
    const log = createWriteStream(logPath);
    const child = spawn(executable, args, { cwd: appRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.on("error", reject);
    child.on("close", (code) => log.end(() => resolve(code ?? 1)));
  });
}

function writeExperiments(experiments, runs, treatment, verbose) {
  resetExperiments(experimentsRoot);
  for (const { benchmark, name } of experiments) {
    writeExperiment(experimentsRoot, name, {
      revision: subject.revision,
      packageSpec: subject.packageSpec,
      runs,
      benchmark,
      treatment,
      verbose,
    });
  }
}

function parseRuns(value) {
  if (value === undefined) return 1;
  return parsePositiveInteger(value, "--runs");
}

function parsePositiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function usage() {
  console.log(`Usage:
  pnpm benchmark [eval-name] [--canary main] [--model <id>] [--runs N] [--treatment baseline|guided] [--dry] [--verbose] [--keep-failures]
  pnpm benchmark [eval-name] --models <id,...|all> [--concurrency N] [--runs N] [--treatment baseline|guided] [--dry] [--keep-failures]`);
}
