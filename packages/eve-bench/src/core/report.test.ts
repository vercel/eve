import assert from "node:assert/strict";
import { test } from "node:test";

import { diffJobs, formatDiff, formatReport } from "./report.ts";
import { summarize, type JobResult, type TrialResult } from "./result.ts";

function trial(
  task: string,
  attempt: number,
  reward: number | null,
  extra: Partial<TrialResult> = {},
): TrialResult {
  return {
    task,
    attempt,
    harness: "eve@local",
    model: "test/model",
    reward,
    agent: { status: "completed", exitCode: 0, durationMs: 1000 },
    verifier: { status: "completed", exitCode: 0, durationMs: 500 },
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.500Z",
    ...extra,
  };
}

function job(name: string, trials: TrialResult[]): JobResult {
  return {
    job: name,
    dataset: { name: "terminal-bench", version: "2.0", commit: "abc" },
    harness: "eve@local",
    model: "test/model",
    trials,
    summary: summarize(trials),
  };
}

test("summarize counts resolved attempts and mean reward", () => {
  const summary = summarize([trial("a", 1, 1), trial("a", 2, 0), trial("b", 1, null)]);
  assert.deepEqual(summary, { tasks: 2, attempts: 3, resolved: 1, meanReward: 1 / 3 });
});

test("junit report marks unresolved trials as failures", () => {
  const output = formatReport(
    job("j", [trial("a", 1, 1), trial("b", 1, 0, { error: "boom <x>" })]),
    "junit",
  );
  assert.match(output, /tests="2" failures="1"/u);
  assert.match(output, /<testcase name="a #1" time="1.500"\/>/u);
  assert.match(output, /<failure message="boom &lt;x>"\/>/u);
});

test("diff reports per-task mean reward deltas", () => {
  const base = job("base", [trial("a", 1, 0), trial("a", 2, 1), trial("b", 1, 1)]);
  const candidate = job("cand", [trial("a", 1, 1), trial("a", 2, 1), trial("c", 1, 0)]);
  const deltas = diffJobs(base, candidate);
  assert.deepEqual(deltas, [
    { task: "a", base: 0.5, candidate: 1, delta: 0.5 },
    { task: "b", base: 1, candidate: null, delta: null },
    { task: "c", base: null, candidate: 0, delta: null },
  ]);
  assert.match(formatDiff(deltas), /1 task\(s\) changed, net \+0.500/u);
});
