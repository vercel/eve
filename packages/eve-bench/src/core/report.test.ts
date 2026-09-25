import assert from "node:assert/strict";
import { test } from "node:test";

import { diffJobs, formatDiff, formatReport } from "./report.ts";
import { classifyTrial, summarize, type JobResult, type TrialResult } from "./result.ts";

const USED = { inputTokens: 100, outputTokens: 10, cachedTokens: 0, costUsd: null };

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
    usage: USED,
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

const harnessInvalid = { phase: "harness", reason: "no model call completed" } as const;

test("classify separates environment, harness, and verifier failures from scored outcomes", () => {
  const base = trial("a", 1, 0);
  assert.equal(classifyTrial(base, false), undefined);
  assert.equal(
    classifyTrial({ ...base, agent: { ...base.agent, status: "timeout" } }, false),
    undefined,
  );

  const setup = classifyTrial(
    {
      ...base,
      error: "docker pull failed",
      agent: { status: "skipped", exitCode: null, durationMs: 0 },
    },
    false,
  );
  assert.equal(setup?.phase, "environment");
  assert.match(setup!.reason, /before the harness started: docker pull failed/);
  assert.equal(
    classifyTrial({ ...base, error: "could not download /logs/agent" }, false)?.phase,
    "environment",
  );

  // A 401 or broken adapter leaves zero usage; a missing log leaves none.
  const zero = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: null };
  assert.equal(classifyTrial({ ...base, usage: zero }, false)?.phase, "harness");
  assert.equal(classifyTrial({ ...base, usage: undefined, reward: 1 }, false)?.phase, "harness");
  assert.equal(classifyTrial({ ...base, usage: undefined }, true), undefined);

  const verifier = classifyTrial(
    { ...base, reward: null, verifier: { status: "timeout", exitCode: null, durationMs: 1 } },
    false,
  );
  assert.deepEqual(verifier, {
    phase: "verifier",
    reason: "verifier timed out without writing a reward",
  });
});

test("summarize scores only valid attempts and counts invalid ones by phase", () => {
  const summary = summarize([
    trial("a", 1, 1),
    trial("a", 2, 0),
    trial("b", 1, 0, { invalid: harnessInvalid }),
    trial("b", 2, null, { invalid: { phase: "verifier", reason: "verifier wrote no reward" } }),
  ]);
  assert.deepEqual(summary, {
    tasks: 2,
    attempts: 4,
    scored: 2,
    invalid: { environment: 0, harness: 1, verifier: 1 },
    resolved: 1,
    meanReward: 0.5,
  });
  assert.equal(summarize([trial("a", 1, 0, { invalid: harnessInvalid })]).meanReward, null);
});

test("junit reports invalid attempts as errors, not failures", () => {
  const output = formatReport(
    job("j", [trial("a", 1, 1), trial("b", 1, 0), trial("c", 1, 0, { invalid: harnessInvalid })]),
    "junit",
  );
  assert.match(output, /tests="3" failures="1" errors="1"/u);
  assert.match(output, /<testcase name="a #1" time="1.500"\/>/u);
  assert.match(output, /<failure message="reward 0; agent completed; verifier completed"\/>/u);
  assert.match(output, /<error message="invalid \(harness\): no model call completed"\/>/u);
});

test("console report lists every invalid attempt with its reason", () => {
  const output = formatReport(
    job("j", [trial("a", 1, 1), trial("a", 2, 0, { invalid: harnessInvalid })]),
    "console",
  );
  assert.match(output, /1\.00 x\s+#2 invalid\(harness\)/u);
  assert.match(output, /scored 1 {2}resolved 1 {2}mean reward 1\.000/u);
  assert.match(output, /invalid attempts excluded from scoring: harness 1/u);
  assert.match(output, /a #2 \[harness\] no model call completed/u);
});

test("diff compares scored attempts and reports invalid counts", () => {
  const base = job("base", [trial("a", 1, 0), trial("a", 2, 1), trial("b", 1, 1)]);
  const candidate = job("cand", [
    trial("a", 1, 1),
    trial("a", 2, 0, { invalid: harnessInvalid }),
    trial("c", 1, 0),
  ]);
  const deltas = diffJobs(base, candidate);
  assert.deepEqual(deltas, [
    { task: "a", base: 0.5, candidate: 1, delta: 0.5, baseInvalid: 0, candidateInvalid: 1 },
    { task: "b", base: 1, candidate: null, delta: null, baseInvalid: 0, candidateInvalid: 0 },
    { task: "c", base: null, candidate: 0, delta: null, baseInvalid: 0, candidateInvalid: 0 },
  ]);
  const text = formatDiff(deltas);
  assert.match(text, /1 task\(s\) changed, net \+0.500/u);
  assert.match(text, /invalid 0 -> 1/u);
  assert.match(text, /1 invalid attempt\(s\) excluded/u);
});
