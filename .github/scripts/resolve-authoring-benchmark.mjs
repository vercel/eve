import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  benchmarkModels,
  publishedBenchmarkModels,
} from "../../apps/benchmarks/lib/benchmark-config.ts";

const DIRECTIVE = /^\s*(?:<!--\s*)?authoring-benchmark:(.*?)(?:-->)?\s*$/mu;

/**
 * Reads `authoring-benchmark: models=a,b|all cases=x,y runs=N` from a PR body.
 * Returns null when the body has no such line, which means nothing runs.
 */
export function parseDirective(body) {
  const line = DIRECTIVE.exec(body ?? "")?.[1];
  if (line === undefined) return null;
  const options = {};
  for (const token of line.trim().split(/\s+/u).filter(Boolean)) {
    const match = /^(models|cases|runs)=(\S+)$/u.exec(token);
    if (!match)
      throw new Error(`Unrecognized authoring-benchmark option ${JSON.stringify(token)}.`);
    options[match[1]] = match[2];
  }
  return options;
}

/** `models` is required; `cases` defaults to the published cases and `runs` to 1. */
export function resolveSelection({ models, cases, runs }, { caseExists }) {
  if (!models?.trim()) {
    throw new Error('Name the models to run, for example "models=kimi-k3" or "models=all".');
  }
  return {
    models: resolveModels(models),
    cases: resolveCases(cases ?? "", caseExists),
    runs: resolveRuns(runs || "1"),
  };
}

function splitList(value) {
  return [...new Set(value.split(/[\s,]+/u).filter(Boolean))];
}

function resolveModels(value) {
  if (value.trim() === "all") return publishedBenchmarkModels.map((model) => model.id);
  return splitList(value).map((name) => {
    const model = benchmarkModels.find((entry) => entry.id === name || entry.model === name);
    if (!model) {
      throw new Error(
        `Unknown model ${JSON.stringify(name)}. Use "all" or one of: ${benchmarkModels.map((entry) => entry.id).join(", ")}.`,
      );
    }
    return model.id;
  });
}

function resolveCases(value, caseExists) {
  const cases = splitList(value);
  for (const name of cases) {
    if (!/^[a-z0-9-]+$/u.test(name) || !caseExists(name)) {
      throw new Error(`Unknown benchmark case ${JSON.stringify(name)}.`);
    }
  }
  return cases.join(",");
}

function resolveRuns(value) {
  const runs = Number(value);
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > 5) {
    throw new Error("runs must be an integer from 1 to 5.");
  }
  return String(runs);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const evalsRoot = join(process.cwd(), "apps/benchmarks/evals");
  const options =
    process.env.GITHUB_EVENT_NAME === "workflow_dispatch"
      ? {
          models: process.env.INPUT_MODELS,
          cases: process.env.INPUT_CASES,
          runs: process.env.INPUT_RUNS,
        }
      : parseDirective(process.env.PR_BODY);
  if (options === null) {
    console.log(
      "::notice::No authoring-benchmark line in the PR body; nothing to run. Add one, then re-add the label.",
    );
    appendFileSync(process.env.GITHUB_OUTPUT, "run=false\n");
    process.exit(0);
  }
  const selection = resolveSelection(options, {
    caseExists: (name) => existsSync(join(evalsRoot, name, "CASE.ts")),
  });
  console.log(JSON.stringify(selection, null, 2));
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `run=true\nmodels=${JSON.stringify(selection.models)}\ncases=${selection.cases}\nruns=${selection.runs}\n`,
  );
}
