import assert from "node:assert/strict";
import { test } from "node:test";

import { graderChecks, recordGraderChecks } from "./checks.ts";

test("reads passed and total tests from Vitest output", () => {
  const output = [
    " ✓ EVAL.ts (13 tests)",
    "",
    " Test Files  1 failed (1)",
    "      Tests  4 failed | 9 passed (13)",
  ].join("\n");
  assert.deepEqual(graderChecks(output), { passed: 9, total: 13, score: 0.692 });
});

test("handles colored output, all-passing, and all-failing runs", () => {
  assert.deepEqual(
    graderChecks("\u001b[2m      Tests \u001b[22m \u001b[32m7 passed\u001b[39m (7)"),
    {
      passed: 7,
      total: 7,
      score: 1,
    },
  );
  assert.deepEqual(graderChecks("      Tests  3 failed (3)"), { passed: 0, total: 3, score: 0 });
});

test("reports nothing when the grader never summarized", () => {
  assert.equal(graderChecks("Error: Cannot find module 'vitest/config'"), undefined);
  assert.equal(graderChecks(undefined), undefined);
});

test("records checks on the run result without dropping other analysis", () => {
  const runData = {
    result: { status: "failed", duration: 1, analysis: { other: true } },
    outputContent: { eval: "      Tests  1 failed | 1 passed (2)" },
  };
  assert.deepEqual(recordGraderChecks({ runData }).result.analysis, {
    other: true,
    checks: { passed: 1, total: 2, score: 0.5 },
  });
  const unscored = { result: { status: "failed", duration: 1 } };
  assert.equal(recordGraderChecks({ runData: unscored }), unscored);
});
