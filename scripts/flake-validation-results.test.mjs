import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isCleanEvalSummary,
  MAX_EVAL_OUTPUT_BYTES,
  parseEvalSummary,
  validateEvalIds,
  zeroFailureUpperBound,
  zeroFailureUpperBound95,
} from "./flake-validation-results.mjs";

const expected = ["redundant-tool-calls", "stale-todo-work"];
const event = (type) => ({ type, data: { modelId: "anthropic/claude-opus-5" } });
const compactions = [
  event("compaction.requested"),
  event("compaction.completed"),
  event("compaction.requested"),
  event("compaction.completed"),
];

// Reduced from the 2026-09-09 diagnostic's CLI JSON, not its distinct on-disk summary artifact.
const clean = {
  target: { capabilities: { devRoutes: true }, kind: "local", url: "http://127.0.0.1:40477/" },
  startedAt: "2026-09-09T02:02:22.000Z",
  completedAt: "2026-09-09T02:02:59.000Z",
  failed: 0,
  scored: 0,
  errored: 0,
  skipped: 0,
  passed: 2,
  results: expected.map((id) => ({
    id,
    verdict: "passed",
    assertions: [{ name: "compaction efficiency", severity: "soft", passed: true, score: 1 }],
    result: {
      status: "waiting",
      output: "Done",
      events: compactions,
      sessions: [{ primary: true, events: compactions }],
    },
  })),
};

test("accepts current CLI JSON with results and no totalEvals", () => {
  assert.equal(isCleanEvalSummary(clean, expected), true);
  const parsed = parseEvalSummary(JSON.stringify(clean), expected);
  assert.equal(parsed.passed, true);
  assert.deepEqual(parsed.summary, clean);
  assert.deepEqual(parsed.issues, []);
});

test("matches the exact expected IDs regardless of discovery order", () => {
  assert.equal(
    isCleanEvalSummary({ ...clean, results: [...clean.results].reverse() }, expected),
    true,
  );
  for (const results of [
    clean.results.slice(0, 1),
    [...clean.results, { ...clean.results[0], id: "unexpected" }],
    [clean.results[0], clean.results[0]],
    [clean.results[0], { ...clean.results[1], id: "wrong" }],
  ]) {
    assert.equal(
      isCleanEvalSummary({ ...clean, passed: results.length, results }, expected),
      false,
    );
  }
  const missing = parseEvalSummary(JSON.stringify({ ...clean, results: [] }), expected);
  assert.equal(missing.passed, false);
  assert.ok(missing.issues.length > 0);
});

test("requires explicit nonempty expected coverage and rejects unsafe selectors", () => {
  for (const ids of [
    undefined,
    [],
    [""],
    ["--json"],
    ["../other"],
    ["a/../b"],
    ["a//b"],
    ["a", "a"],
    ["x".repeat(257)],
    Array.from({ length: 65 }, (_, i) => `eval-${i}`),
  ]) {
    assert.throws(() => validateEvalIds(ids));
    assert.throws(() => isCleanEvalSummary(clean, ids));
  }
  assert.doesNotThrow(() => validateEvalIds(["group/eval", "example-1.2"]));
  assert.doesNotThrow(() => validateEvalIds([], { required: false }));
});

test("rejects malformed, missing, noisy, empty, and oversized JSON output", () => {
  for (const output of [
    undefined,
    null,
    "",
    "not JSON",
    "{",
    "null",
    "[]",
    "{}",
    `log before JSON\n${JSON.stringify(clean)}`,
    `${JSON.stringify(clean)}\nlog after JSON`,
    " ".repeat(MAX_EVAL_OUTPUT_BYTES + 1),
  ]) {
    const parsed = parseEvalSummary(output, expected);
    assert.equal(parsed.passed, false);
    assert.ok(parsed.issues.length > 0);
  }
  assert.equal(parseEvalSummary(`\n${JSON.stringify(clean)}\n`, expected).passed, true);
});

test("rejects artifact summaries, which are not the CLI stdout contract", () => {
  const { results, ...summary } = clean;
  assert.equal(isCleanEvalSummary({ ...summary, totalEvals: 2, evals: results }, expected), false);
});

for (const field of ["passed", "failed", "scored", "errored", "skipped"]) {
  test(`rejects missing, invalid, and inconsistent ${field} counters`, () => {
    for (const value of [undefined, null, -1, 0.5, "0", NaN, Infinity, 3]) {
      assert.equal(isCleanEvalSummary({ ...clean, [field]: value }, expected), false);
    }
  });
}

test("rejects failed, skipped, scored, unknown, and malformed per-eval results", () => {
  for (const replacement of [
    null,
    {},
    { id: "stale-todo-work" },
    ...["failed", "scored", "skipped", "unknown"].map((verdict) => ({
      ...clean.results[1],
      verdict,
    })),
    { ...clean.results[1], error: "unexpected error" },
    { ...clean.results[1], error: null },
    { ...clean.results[1], skipReason: "not selected" },
    { ...clean.results[1], assertions: undefined },
    { ...clean.results[1], assertions: [null] },
    { ...clean.results[1], assertions: [{ severity: "gate", passed: true }] },
    {
      ...clean.results[1],
      assertions: [{ name: "required", score: null, severity: "gate", passed: true }],
    },
    { ...clean.results[1], assertions: [{ passed: false, severity: "gate" }] },
    { ...clean.results[1], assertions: [{ passed: false, severity: "unknown" }] },
    { ...clean.results[1], result: undefined },
    { ...clean.results[1], result: { events: [null] } },
  ]) {
    const parsed = parseEvalSummary(
      JSON.stringify({ ...clean, results: [clean.results[0], replacement] }),
      expected,
    );
    assert.equal(parsed.passed, false);
    assert.ok(parsed.issues.length > 0);
  }
});

test("rejects skipped, scored, and failed results even with consistent aggregate counts", () => {
  for (const verdict of ["skipped", "scored", "failed"]) {
    const summary = {
      ...clean,
      passed: 1,
      [verdict]: 1,
      results: [clean.results[0], { ...clean.results[1], verdict }],
    };
    assert.equal(isCleanEvalSummary(summary, expected), false);
  }
});

test("retains failed soft metrics without overriding a passed CLI verdict", () => {
  const results = structuredClone(clean.results);
  const soft = {
    name: "compaction efficiency",
    severity: "soft",
    score: 0,
    passed: false,
  };
  results[1].assertions = [
    { name: "completed required work", severity: "gate", score: 1, passed: true },
    soft,
  ];
  const parsed = parseEvalSummary(JSON.stringify({ ...clean, results }), expected);
  assert.equal(parsed.passed, true);
  assert.deepEqual(parsed.evals[1].softMetrics, [
    {
      name: soft.name,
      score: 0,
      threshold: undefined,
      passed: false,
    },
  ]);
  results[1].assertions[0].passed = false;
  assert.equal(parseEvalSummary(JSON.stringify({ ...clean, results }), expected).passed, false);
});

test("expects root CLI events and rejects persisted details that only retain session snapshots", () => {
  const results = structuredClone(clean.results);
  delete results[1].result.events;
  const parsed = parseEvalSummary(JSON.stringify({ ...clean, results }), expected);
  assert.equal(parsed.passed, false);
  assert.ok(parsed.issues.includes("stale-todo-work: missing or malformed event log"));
  assert.equal(parsed.evals[1].compaction, null);
});

test("records the saved refusal shape with five requests and one completed compaction", () => {
  const failure = {
    ...clean,
    passed: 1,
    failed: 1,
    errored: 1,
    results: [
      clean.results[0],
      {
        ...clean.results[1],
        verdict: "failed",
        error:
          'Eval turn failed: session.failed: FatalError Step "turnStep" failed after 3 retries: The compaction model returned an empty summary. Finish reason: content-filter.',
        assertions: [],
        result: {
          status: "failed",
          events: [
            event("compaction.requested"),
            event("compaction.completed"),
            ...Array.from({ length: 4 }, () => event("compaction.requested")),
            { type: "session.failed" },
          ],
        },
      },
    ],
  };
  const parsed = parseEvalSummary(JSON.stringify(failure), expected);
  assert.equal(parsed.passed, false);
  assert.match(parsed.evals[1].error, /content-filter/);
  assert.deepEqual(parsed.evals[1].compaction, {
    requested: 5,
    completed: 1,
    uncompletedRequests: 4,
    modelIds: ["anthropic/claude-opus-5"],
  });
});

test("exposes unsuccessful compaction attempts even when the final eval passes", () => {
  const results = structuredClone(clean.results);
  results[1].result.events.push(event("compaction.requested"));
  const parsed = parseEvalSummary(JSON.stringify({ ...clean, results }), expected);
  assert.equal(parsed.passed, true);
  assert.equal(parsed.evals[1].compaction.requested, 3);
  assert.equal(parsed.evals[1].compaction.completed, 2);
  assert.equal(parsed.evals[1].compaction.uncompletedRequests, 1);
});

test("does not double-count the top-level events duplicated in session snapshots", () => {
  const parsed = parseEvalSummary(JSON.stringify(clean), expected);
  assert.deepEqual(
    parsed.evals.map((result) => result.compaction.requested),
    [2, 2],
  );
  assert.deepEqual(
    parsed.evals.map((result) => result.compaction.completed),
    [2, 2],
  );
});

test("distinguishes zero observed compactions from missing event evidence", () => {
  const results = clean.results.map((result) => ({ ...result, result: { events: [] } }));
  const parsed = parseEvalSummary(JSON.stringify({ ...clean, results }), expected);
  assert.equal(parsed.passed, true);
  assert.deepEqual(parsed.evals[0].compaction, {
    requested: 0,
    completed: 0,
    uncompletedRequests: 0,
    modelIds: [],
  });
});

test("computes the exact one-sided 95% zero-failure binomial bound", () => {
  assert.equal(zeroFailureUpperBound, zeroFailureUpperBound95);
  assert.equal(zeroFailureUpperBound95(1), 0.95);
  for (const runs of [20, 100, 500]) {
    const bound = zeroFailureUpperBound95(runs);
    assert.ok(Math.abs((1 - bound) ** runs - 0.05) < 1e-12);
  }
  assert.ok(zeroFailureUpperBound95(20) > 0.139 && zeroFailureUpperBound95(20) < 0.14);
  assert.ok(zeroFailureUpperBound95(100) > 0.029 && zeroFailureUpperBound95(100) < 0.03);
  assert.ok(zeroFailureUpperBound95(500) > 0.0059 && zeroFailureUpperBound95(500) < 0.006);
});

test("does not report confidence without valid trial counts", () => {
  for (const runs of [0, -1, 0.5, "20", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => zeroFailureUpperBound95(runs), /positive integer/);
  }
});
