import assert from "node:assert/strict";
import test from "node:test";

import { judgePrompt } from "../../extension/lib/judge.ts";
import { check, settle } from "../../extension/lib/policy.ts";
import type { Goal } from "../../extension/lib/state.ts";

const goal: Goal = {
  idleRuns: 0,
  maxRuns: 3,
  objective: "Alice's test suite passes.",
  runs: 0,
  status: "active",
};

const turn = { continued: true, costUsd: 1, outcome: "completed", toolCalls: 2 } as const;

test("a completed turn with progress and budget goes to the judge", () => {
  assert.deepEqual(check(goal, turn, {}), { idleRuns: 0, kind: "judge" });
});

test("a turn that didn't complete pauses the goal", () => {
  assert.deepEqual(check(goal, { ...turn, outcome: "cancelled" }, {}), {
    kind: "pause",
    reason: "The turn cancelled.",
  });
});

test("idle continuations pause on the second in a row, and a person's turn resets the count", () => {
  const idle = { ...turn, toolCalls: 0 };
  assert.deepEqual(check(goal, idle, {}), { idleRuns: 1, kind: "judge" });
  assert.equal(check({ ...goal, idleRuns: 1 }, idle, {}).kind, "pause");
  assert.deepEqual(check({ ...goal, idleRuns: 1 }, { ...idle, continued: false }, {}), {
    idleRuns: 0,
    kind: "judge",
  });
});

test("the run and spend budgets pause the goal", () => {
  assert.deepEqual(check({ ...goal, runs: 3 }, turn, {}), {
    kind: "pause",
    reason: "The goal reached its limit of 3 runs.",
  });
  assert.deepEqual(check({ ...goal, costAtStart: 2 }, { ...turn, costUsd: 7 }, { maxCostUsd: 5 }), {
    kind: "pause",
    reason: "The goal spent $5.00 of its $5.00 budget.",
  });
  assert.equal(
    check({ ...goal, costAtStart: 2 }, { ...turn, costUsd: 6 }, { maxCostUsd: 5 }).kind,
    "judge",
  );
});

test("continue counts a run and steers the next turn with the judge's reason", () => {
  const next = settle(goal, { reason: "Two tests still fail in auth.", verdict: "continue" }, 1);
  assert.deepEqual(next.goal, {
    ...goal,
    idleRuns: 1,
    lastReason: "Two tests still fail in auth.",
    runs: 1,
  });
  assert.equal(next.message, "Continue working toward the goal. Two tests still fail in auth.");
});

test("met and impossible settle the goal without a message", () => {
  for (const verdict of ["met", "impossible"] as const) {
    const next = settle(goal, { reason: "The suite passed.", verdict }, 0);
    assert.equal(next.goal.status, verdict);
    assert.equal(next.message, undefined);
  }
});

test("a judge failure pauses the goal", () => {
  const next = settle(goal, undefined, 0);
  assert.equal(next.goal.status, "paused");
  assert.equal(next.goal.lastReason, "The goal judge failed.");
  assert.equal(next.message, undefined);
});

test("the judge prompt keeps the latest calls when evidence overflows", () => {
  const prompt = judgePrompt({
    calls: Array.from({ length: 400 }, (_, index) => ({
      input: { command: "pnpm test" },
      name: "bash",
      output: { index, stdout: "x".repeat(100) },
      state: "succeeded",
    })),
    input: "Alice asks to fix the tests.",
    objective: goal.objective,
    reply: "Fixed one test.",
  });
  assert.match(prompt, /<goal>Alice's test suite passes\.<\/goal>/u);
  assert.match(prompt, /"index":399/u);
  assert.doesNotMatch(prompt, /"index":0,/u);
  assert.match(prompt, /omitted_earlier="\d+"/u);
});
