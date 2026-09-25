import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { summarize, type JobResult, type TrialResult } from "../../src/core/result.ts";

const exec = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function trial(attempt: number, extra: Partial<TrialResult> = {}): TrialResult {
  return {
    task: "a",
    attempt,
    harness: "pi@0.85.1",
    model: "test/model",
    reward: 0,
    agent: { status: "completed", exitCode: 0, durationMs: 1 },
    verifier: { status: "completed", exitCode: 0, durationMs: 1 },
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    ...extra,
  };
}

async function report(t: TestContext, trials: TrialResult[], ...args: string[]) {
  const job = `cli-report-test-${randomUUID().slice(0, 8)}`;
  const dir = join(packageRoot, ".generated", "jobs", job);
  await mkdir(dir, { recursive: true });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result: JobResult = {
    job,
    dataset: { name: "local", version: "0", commit: "" },
    harness: "pi@0.85.1",
    model: "test/model",
    trials,
    summary: summarize(trials),
  };
  await writeFile(join(dir, "result.json"), JSON.stringify(result));
  return exec(process.execPath, ["src/cli.ts", "report", job, ...args], { cwd: packageRoot }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error: { code: number; stdout: string; stderr: string }) => error,
  );
}

test("report --fail-on-invalid exits 1 and names each invalid attempt", async (t) => {
  const result = await report(
    t,
    [
      trial(1),
      trial(2, { invalid: { phase: "harness", reason: "harness reported zero token usage" } }),
    ],
    "--fail-on-invalid",
  );
  assert.equal(result.code, 1);
  assert.match(result.stdout, /a #2 \[harness\] harness reported zero token usage/);
  assert.match(result.stderr, /1 of 2 attempt\(s\) are invalid/);
});

test("report --fail-on-invalid passes when every attempt was scored, including failures", async (t) => {
  const result = await report(t, [trial(1), trial(2, { reward: 1 })], "--fail-on-invalid");
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /scored 2 {2}resolved 1/);
});
