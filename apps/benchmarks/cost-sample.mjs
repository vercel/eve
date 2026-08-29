#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  authoringTreatments,
  findPublishedBenchmarkModel,
  publishedBenchmark,
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
    revision: { type: "string", required: true },
    models: { type: "string", required: true },
  },
  strict: true,
});

const revision = git(["rev-parse", "--verify", `${values.revision}^{commit}`]).trim();
const benchmarks = values.models.split(",").map((model) => findPublishedBenchmarkModel(model));
const subject = revisionSubject(repositoryRoot, revision, "published");
const experiments = benchmarks.flatMap((benchmark) =>
  authoringTreatments.map(
    (treatment) => `${publishedExperimentId(benchmark, treatment)}-cost-sample`,
  ),
);

prepareFixtures(evalsRoot);
resetExperiments(experimentsRoot);
const { archiveName, dependencyArchiveName } = writeSubjectArchives(
  experimentsRoot,
  subject,
  `published-${revision.slice(0, 12)}`,
);
for (const benchmark of benchmarks) {
  for (const treatment of authoringTreatments) {
    writeExperiment(experimentsRoot, `${publishedExperimentId(benchmark, treatment)}-cost-sample`, {
      archiveName,
      dependencyArchiveName,
      digest: subject.digest,
      dependencyDigest: subject.dependencyDigest,
      runs: 1,
      evals: publishedBenchmark.caseIds,
      benchmark,
      treatment,
    });
  }
}

console.log(`> eve revision: ${revision}`);
console.log(`> models: ${benchmarks.map((benchmark) => benchmark.displayName).join(", ")}`);
console.log("> cost samples per model/treatment/case: 1");
const result = spawnSync(
  join(appRoot, "node_modules/.bin/agent-eval"),
  ["run", ...experiments, "--force"],
  {
    cwd: appRoot,
    stdio: "inherit",
    env: process.env,
  },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);

function git(args) {
  return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" });
}
