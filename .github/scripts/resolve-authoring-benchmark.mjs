import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  benchmarkModels,
  publishedBenchmark,
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

/**
 * `models` is required; `cases` defaults to the published cases (`all` selects
 * every case the native runner can run) and `runs` to 1.
 */
export function resolveSelection({ models, cases, runs }, { caseExists, allCases }) {
  if (!models?.trim()) {
    throw new Error('Name the models to run, for example "models=kimi-k3" or "models=all".');
  }
  return {
    models: resolveModels(models),
    cases: cases?.trim() === "all" ? allCases().join(",") : resolveCases(cases ?? "", caseExists),
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

// Defaults resolve to the concrete list, so the run and publish jobs share one plan.
function resolveCases(value, caseExists) {
  const cases = splitList(value);
  if (cases.length === 0) return publishedBenchmark.caseIds.join(",");
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

/** Maps the triggering event to request options, or null when a PR asks for nothing. */
export function requestOptions(env) {
  // The nightly run tracks one model across every case, with repeats to smooth noise.
  if (env.GITHUB_EVENT_NAME === "schedule") {
    return { models: "claude-haiku-5-5", cases: "all", runs: "3" };
  }
  if (env.GITHUB_EVENT_NAME === "workflow_dispatch") {
    return { models: env.INPUT_MODELS, cases: env.INPUT_CASES, runs: env.INPUT_RUNS };
  }
  return parseDirective(env.PR_BODY);
}

/**
 * A dispatch on main that covers every supported model on the published cases
 * at the published run count is a full run: it also runs the baseline
 * treatment so the site job can refresh eve.dev/benchmarks.
 */
export function isSiteRun(selection, env) {
  if (env.GITHUB_EVENT_NAME !== "workflow_dispatch" || env.GITHUB_REF !== "refs/heads/main") {
    return false;
  }
  return (
    sameSet(
      selection.models,
      publishedBenchmarkModels.map((model) => model.id),
    ) &&
    sameSet(selection.cases.split(","), publishedBenchmark.caseIds) &&
    Number(selection.runs) === publishedBenchmark.runs
  );
}

/** One benchmark job per model and treatment. Only full runs add the baseline. */
export function benchmarkMatrix(selection, site) {
  const treatments = site ? ["guided", "baseline"] : ["guided"];
  return treatments.flatMap((treatment) => selection.models.map((model) => ({ model, treatment })));
}

function sameSet(left, right) {
  const set = new Set(left);
  return set.size === new Set(right).size && right.every((value) => set.has(value));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const evalsRoot = join(process.cwd(), "apps/benchmarks/evals");
  const options = requestOptions(process.env);
  if (options === null) {
    console.log(
      "::notice::No authoring-benchmark line in the PR body; nothing to run. Add one, then re-add the label.",
    );
    appendFileSync(process.env.GITHUB_OUTPUT, "run=false\n");
    process.exit(0);
  }
  // Loading cases needs the benchmark app's dependencies, so only `all` pays for it.
  const allCases =
    options.cases?.trim() === "all"
      ? await (
          await import("../../apps/benchmarks/lib/experiment-files.mjs")
        ).nativeFixtureNames(evalsRoot)
      : [];
  const selection = resolveSelection(options, {
    caseExists: (name) => existsSync(join(evalsRoot, name, "CASE.ts")),
    allCases: () => allCases,
  });
  const site = isSiteRun(selection, process.env);
  const matrix = benchmarkMatrix(selection, site);
  console.log(JSON.stringify({ ...selection, site }, null, 2));
  if (site) {
    console.log(
      "::notice::Full run: every supported model also runs the baseline treatment, and eve.dev/benchmarks is refreshed.",
    );
  }
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `run=true\nmodels=${JSON.stringify(selection.models)}\ncases=${selection.cases}\nruns=${selection.runs}\nsite=${site}\nmatrix=${JSON.stringify(matrix)}\n`,
  );
}
