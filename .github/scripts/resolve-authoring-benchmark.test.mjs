import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { publishedBenchmark } from "../../apps/benchmarks/lib/benchmark-config.ts";
import {
  fixtureNames,
  nativeFixtureNames,
  prepareFixtures,
} from "../../apps/benchmarks/lib/experiment-files.mjs";
import {
  parseDirective,
  requestOptions,
  resolveSelection,
} from "./resolve-authoring-benchmark.mjs";

const context = {
  caseExists: (name) => name.startsWith("author-"),
  allCases: () => ["author-000-x", "author-001-y"],
};

test("does nothing without an authoring-benchmark line", () => {
  assert.equal(parseDirective("Fixes a bug."), null);
  assert.equal(parseDirective(undefined), null);
});

test("requires models", () => {
  assert.throws(() => resolveSelection(parseDirective("authoring-benchmark:"), context), /models/u);
  assert.throws(
    () => resolveSelection(parseDirective("authoring-benchmark: cases=author-001-x"), context),
    /models/u,
  );
});

test("defaults to the published cases and one run", () => {
  assert.deepEqual(
    resolveSelection(parseDirective("authoring-benchmark: models=kimi-k3"), context),
    {
      models: ["kimi-k3"],
      cases: publishedBenchmark.caseIds.join(","),
      runs: "1",
    },
  );
});

test("reads models, cases, and runs from the PR body", () => {
  const body = [
    "Summary",
    "",
    "authoring-benchmark: models=kimi-k3,openai/gpt-6-sol cases=author-008-restock-agent runs=3",
  ].join("\n");
  assert.deepEqual(resolveSelection(parseDirective(body), context), {
    models: ["kimi-k3", "gpt-6-sol-high"],
    cases: "author-008-restock-agent",
    runs: "3",
  });
});

test("accepts the directive inside an HTML comment", () => {
  assert.deepEqual(parseDirective("<!-- authoring-benchmark: cases=author-001-weather-tool -->"), {
    cases: "author-001-weather-tool",
  });
});

test("expands all to the supported models", () => {
  const { models } = resolveSelection({ models: "all" }, context);
  assert.ok(models.length > 1);
  assert.ok(!models.includes("claude-sonnet-4-6"));
});

test("rejects unknown models, cases, options, and run counts", () => {
  assert.throws(() => resolveSelection({ models: "nope" }, context), /Unknown model/u);
  assert.throws(
    () => resolveSelection({ models: "kimi-k3", cases: "../etc" }, context),
    /Unknown benchmark case/u,
  );
  assert.throws(() => parseDirective("authoring-benchmark: model=kimi-k3"), /Unrecognized/u);
  assert.throws(
    () => resolveSelection({ models: "kimi-k3", runs: "10" }, context),
    /runs must be/u,
  );
});

test("runs Haiku 5.5 on every case three times at night", () => {
  // A stray PR body or dispatch input must not narrow the nightly run.
  const options = requestOptions({
    GITHUB_EVENT_NAME: "schedule",
    INPUT_MODELS: "kimi-k3",
    PR_BODY: "authoring-benchmark: models=kimi-k3",
  });
  assert.deepEqual(resolveSelection(options, context), {
    models: ["claude-haiku-5-5"],
    cases: "author-000-x,author-001-y",
    runs: "3",
  });
});

test("reads dispatch inputs, or the PR body for label runs", () => {
  assert.deepEqual(
    requestOptions({
      GITHUB_EVENT_NAME: "workflow_dispatch",
      INPUT_MODELS: "kimi-k3",
      INPUT_CASES: "",
      INPUT_RUNS: "2",
    }),
    { models: "kimi-k3", cases: "", runs: "2" },
  );
  assert.equal(
    requestOptions({ GITHUB_EVENT_NAME: "pull_request", PR_BODY: "Fixes a bug." }),
    null,
  );
});

test("all selects only the cases the native runner can prepare", async () => {
  const evalsRoot = join(import.meta.dirname, "../../apps/benchmarks/evals");
  const cases = await nativeFixtureNames(evalsRoot);
  assert.ok(fixtureNames(evalsRoot).includes("author-000-imessage"));
  assert.ok(!cases.includes("author-000-imessage"));
  await prepareFixtures(evalsRoot, { revision: "main" }, cases);
});
