import assert from "node:assert/strict";
import { test } from "node:test";

import { isCleanEvalSummary, zeroFailureUpperBound } from "./flake-validation-results.mjs";
import {
  checkDeploymentRevision,
  DEPLOYMENT_PENDING_CODE,
  DEPLOYMENT_REVISION_HEADER,
} from "../e2e/fixtures/agent-channels/agent/lib/deployment-revision.ts";

const clean = {
  failed: 0,
  scored: 0,
  errored: 0,
  skipped: 0,
  passed: 1,
  results: [{ id: "example", verdict: "passed" }],
};

test("accepts the CLI summary shape, which has results rather than totalEvals", () => {
  assert.equal(isCleanEvalSummary(clean), true);
});

for (const field of ["failed", "scored", "errored", "skipped"]) {
  test(`rejects ${field} evals`, () => {
    assert.equal(isCleanEvalSummary({ ...clean, [field]: 1 }), false);
  });
}

test("rejects missing, empty, and inconsistent result sets", () => {
  for (const summary of [
    undefined,
    null,
    {},
    { ...clean, results: undefined, totalEvals: 1 },
    { ...clean, passed: 0, results: [] },
    { ...clean, passed: 2 },
    { ...clean, results: [{ verdict: "failed" }] },
    { ...clean, results: [{ verdict: "passed", error: "unexpected error" }] },
  ]) {
    assert.equal(isCleanEvalSummary(summary), false);
  }
});

test("computes the exact one-sided 95% zero-failure binomial bound", () => {
  assert.equal(zeroFailureUpperBound(1), 0.95);
  const bound = zeroFailureUpperBound(500);
  assert.ok(bound > 0.0059 && bound < 0.006);
  assert.ok(Math.abs((1 - bound) ** 500 - 0.05) < 1e-12);
  assert.ok(zeroFailureUpperBound(20) > bound);
});

test("does not report confidence without valid trials", () => {
  for (const runs of [0, -1, 0.5, NaN, Infinity]) {
    assert.throws(() => zeroFailureUpperBound(runs), /positive integer/);
  }
});

test("rejects stale deployment requests before dispatch without changing unpinned traffic", async () => {
  const request = new Request("https://fixture.example/cross-version-webhook", {
    headers: { [DEPLOYMENT_REVISION_HEADER]: "requested-revision" },
  });
  const rejected = checkDeploymentRevision(request, "previous-revision");
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).code, DEPLOYMENT_PENDING_CODE);
  assert.equal(checkDeploymentRevision(request, "requested-revision"), undefined);
  assert.equal(
    checkDeploymentRevision(
      new Request("https://fixture.example/cross-version-webhook"),
      "previous-revision",
    ),
    undefined,
  );
});
