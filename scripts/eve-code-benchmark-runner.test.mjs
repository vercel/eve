import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  normalizeResult,
  redactSecrets,
  runnerArgs,
  shardTasks,
  validateConfig,
  validateDatasetLock,
  verifyProvenance,
} from "./eve-code-benchmark.mjs";

const exec = promisify(execFile);
const config = JSON.parse(
  await readFile(new URL("./eve-code-benchmark-config.json", import.meta.url), "utf8"),
);
const model = "openai/gpt-5.6-terra";
const { tasks, ...dataset } = config.dataset;

function reports(armId = "candidate") {
  const arm = config.arms.find((entry) => entry.id === armId);
  const expected = {
    arm,
    model,
    dataset,
    task: tasks[0],
    job: "ci-123-2-candidate-0-task-fresh",
    source: {
      gitSha: "a".repeat(40),
      agentSha256: "b".repeat(64),
      extensionSha256: "c".repeat(64),
      eveDistSha256: "d".repeat(64),
    },
  };
  const header = {
    job: expected.job,
    harness: arm.harness,
    model,
    dataset: structuredClone(dataset),
  };
  const bundle =
    arm.harness === "e0"
      ? { model, source: structuredClone(expected.source) }
      : {
          [{
            codex: "codex",
            "claude-code": "version",
            opencode: "opencodeVersion",
            hermes: "version",
          }[armId]]: arm.version,
        };
  const job = { ...structuredClone(header), attempts: 1, tasks: [expected.task], bundle };
  const trial = {
    task: expected.task,
    attempt: 1,
    harness: arm.harness,
    model,
    reward: 1,
    agent: { status: "completed", exitCode: 0, durationMs: 1000 },
    verifier: { status: "completed", exitCode: 0, durationMs: 500 },
    startedAt: "2026-09-17T00:00:00.000Z",
    finishedAt: "2026-09-17T00:00:02.000Z",
    usage: { costUsd: 0.12 },
  };
  return { expected, job, result: { ...header, trials: [trial] }, trial };
}

function normalized(fixture, options) {
  return normalizeResult(fixture.job, fixture.result, fixture.expected, options);
}

test("shared config pins six arms, 89 unique tasks, one attempt, and eight balanced shards", () => {
  assert.equal(validateConfig(config), config);
  const shards = Array.from({ length: 8 }, (_, shard) => shardTasks(config, shard));
  assert.deepEqual(
    shards.map((shard) => shard.length),
    [12, 11, 11, 11, 11, 11, 11, 11],
  );
  assert.equal(new Set(shards.flat()).size, 89);
  assert.deepEqual(shards.flat().sort(), [...tasks].sort());
  for (const [index, task] of tasks.entries()) assert.ok(shards[index % 8].includes(task));
  for (const shard of [-1, 8, 0.5, NaN, "0"]) assert.throws(() => shardTasks(config, shard));
  for (const mutate of [
    (c) => {
      c.dataset.tasks[1] = c.dataset.tasks[0];
    },
    (c) => {
      c.runnerRevision = "main";
    },
    (c) => {
      c.baselineRevision = "ca27";
    },
    (c) => {
      c.attempts = 2;
    },
    (c) => {
      c.arms[2].version = "latest";
    },
  ]) {
    const invalid = structuredClone(config);
    mutate(invalid);
    assert.throws(() => validateConfig(invalid));
  }
});

test("dataset lock must have the exact task set and commit, not a subset, duplicate, correction, or floating source", () => {
  const lock = {
    name: dataset.name,
    version: dataset.version,
    sources: [{ kind: "git", commit: dataset.commit, tasks: [...tasks].reverse() }],
  };
  validateDatasetLock(lock, config.dataset);
  for (const mutate of [
    (l) => {
      l.name = "swe-lean";
    },
    (l) => {
      l.version = "1.0";
    },
    (l) => {
      l.sources[0].commit = "main";
    },
    (l) => {
      l.sources[0].tasks.pop();
    },
    (l) => {
      l.sources[0].tasks[0] = l.sources[0].tasks[1];
    },
    (l) => {
      l.sources[0].kind = "path";
    },
    (l) => {
      l.sources.push(structuredClone(l.sources[0]));
    },
    (l) => {
      l.sources[0].corrections = [{ task: tasks[0] }];
    },
  ]) {
    const invalid = structuredClone(lock);
    mutate(invalid);
    assert.throws(() => validateDatasetLock(invalid, config.dataset));
  }
});

test("legacy CLI runs exactly one task and attempt at concurrency one, with the same unmodified model", () => {
  for (const arm of config.arms) {
    const args = runnerArgs({
      runner: "/runner",
      arm,
      model,
      task: tasks[0],
      job: "fresh-job",
      agent: "/eve/apps/fixtures/eve-code-bench",
    });
    assert.deepEqual(args, [
      "/runner/src/cli.ts",
      "run",
      "--harness",
      arm.harness,
      "--model",
      model,
      "--dataset",
      "terminal-bench",
      "--task",
      tasks[0],
      "--attempts",
      "1",
      "--concurrency",
      "1",
      "--job",
      "fresh-job",
      ...(arm.harness === "e0" ? ["--agent", "/eve/apps/fixtures/eve-code-bench"] : []),
    ]);
    assert.equal(args.filter((arg) => arg === "--task").length, 1);
    assert.ok(!args.includes("--native-build"));
  }
});

test("successful reports preserve only compact metrics", () => {
  const fixture = reports();
  assert.deepEqual(normalized(fixture), {
    task: tasks[0],
    attempt: 1,
    reward: 1,
    durationMs: 2000,
    costUsd: 0.12,
    error: false,
  });
  delete fixture.trial.usage;
  assert.equal(normalized(fixture).costUsd, null);
});

test("reward zero and verifier exit one are normal failed tasks, including failed model execution", () => {
  const fixture = reports();
  fixture.trial.reward = 0;
  fixture.trial.verifier = { status: "failed", exitCode: 1, durationMs: 500 };
  assert.equal(normalized(fixture).error, false);
  fixture.trial.agent = { status: "failed", exitCode: 1, durationMs: 1000 };
  assert.equal(normalized(fixture).error, false);
  assert.equal(normalized(fixture).reward, 0);
  fixture.trial.agent = { status: "timeout", exitCode: null, durationMs: 1000 };
  assert.equal(normalized(fixture).error, false);
  assert.equal(normalized(fixture).reward, 0);
});

test("null reward, infrastructure errors, and interrupted child processes cannot produce a score", () => {
  for (const mutate of [
    (f) => {
      f.trial.reward = null;
    },
    (f) => {
      f.trial.error = "Docker pull failed";
    },
    (f) => {
      f.trial.verifier.status = "skipped";
    },
    (f) => {
      f.trial.verifier.status = "timeout";
    },
    (f) => {
      f.trial.agent.status = "skipped";
    },
  ]) {
    const fixture = reports();
    mutate(fixture);
    assert.equal(normalized(fixture).error, true);
    assert.equal(normalized(fixture).reward, null);
  }
  for (const exitCode of [1, 130, 143, null]) {
    const result = normalized(reports(), { exitCode });
    assert.equal(result.error, true);
    assert.equal(result.reward, null);
  }
});

test("missing, malformed, extra, and mismatched report data fails closed", () => {
  for (const mutate of [
    (f) => {
      f.job = undefined;
    },
    (f) => {
      f.result = null;
    },
    (f) => {
      f.job.job = "resumed-old-job";
    },
    (f) => {
      f.result.job = "other-job";
    },
    (f) => {
      f.job.tasks = [tasks[1]];
    },
    (f) => {
      f.job.attempts = 2;
    },
    (f) => {
      f.result.trials.push(structuredClone(f.trial));
    },
    (f) => {
      f.result.trials = [];
    },
    (f) => {
      f.trial.task = tasks[1];
    },
    (f) => {
      f.trial.attempt = 2;
    },
    (f) => {
      f.trial.model = "another/model";
    },
    (f) => {
      f.trial.harness = "eve";
    },
    (f) => {
      f.job.harness = "eve";
    },
    (f) => {
      f.result.model = "another/model";
    },
    (f) => {
      f.job.dataset.commit = "wrong";
    },
    (f) => {
      f.result.dataset.name = "swe-lean";
    },
    (f) => {
      f.trial.reward = "1";
    },
    (f) => {
      f.trial.reward = Infinity;
    },
    (f) => {
      f.trial.reward = 2;
    },
    (f) => {
      f.trial.usage.costUsd = -1;
    },
    (f) => {
      f.trial.finishedAt = "invalid";
    },
    (f) => {
      f.trial.agent.durationMs = NaN;
    },
    (f) => {
      f.trial.verifier = undefined;
    },
  ]) {
    const fixture = reports();
    mutate(fixture);
    const result = normalized(fixture, { durationMs: 123 });
    assert.deepEqual(result, {
      task: tasks[0],
      attempt: 1,
      reward: null,
      durationMs: 123,
      costUsd: null,
      error: true,
    });
  }
});

test("both e0 arms require every captured pre-build source hash and the root model", () => {
  for (const arm of ["baseline", "candidate"]) {
    const fixture = reports(arm);
    verifyProvenance(fixture.job, fixture.result, fixture.expected);
    for (const key of Object.keys(fixture.expected.source)) {
      const invalid = reports(arm);
      invalid.job.bundle.source[key] = "stale";
      assert.throws(() => verifyProvenance(invalid.job, invalid.result, invalid.expected));
      assert.equal(normalized(invalid).reward, null);
    }
    fixture.job.bundle.model = "different/model";
    assert.equal(normalized(fixture).error, true);
  }
});

test("all competitor provenance versions must match their configured pin", () => {
  for (const arm of config.arms.filter((arm) => arm.version)) {
    const fixture = reports(arm.id);
    assert.equal(normalized(fixture).error, false);
    const versionKey = Object.keys(fixture.job.bundle)[0];
    fixture.job.bundle[versionKey] = "latest";
    assert.equal(normalized(fixture).reward, null);
    delete fixture.job.bundle[versionKey];
    assert.equal(normalized(fixture).error, true);
  }
});

test("raw diagnostics redact exact provider credentials, including JSON-escaped error strings", () => {
  const secret = 'key-"quoted"-\\-\n-secret';
  const raw = JSON.stringify({
    trials: [{ error: `request failed: ${secret}`, reward: null }],
    nested: { token: "other-key" },
  });
  const redacted = JSON.parse(redactSecrets(raw, [secret, "other-key", "", undefined]));
  assert.equal(redacted.trials[0].error, "request failed: [REDACTED]");
  assert.equal(redacted.nested.token, "[REDACTED]");
  assert.equal(redactSecrets("invalid JSON: other-key", ["other-key"]), "invalid JSON: [REDACTED]");
  assert.equal(
    redactSecrets(raw.slice(0, -1), [secret]).includes(JSON.stringify(secret).slice(1, -1)),
    false,
  );
});

test("CLI setup failure writes an empty atomic compact report without importing or running the runner", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "eve-code-benchmark-runner-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  await mkdir(join(temp, "scripts"));
  for (const name of ["eve-code-benchmark.mjs", "eve-code-benchmark-config.json"]) {
    await copyFile(new URL(`./${name}`, import.meta.url), join(temp, "scripts", name));
  }
  const env = {
    ...process.env,
    BENCHMARK_ARM: "codex",
    BENCHMARK_SHARD: "0",
    BENCHMARK_MODEL: model,
    TESTED_SHA: "",
    BENCHMARK_RUNNER: join(temp, "absent-runner"),
  };
  await assert.rejects(
    exec(process.execPath, [join(temp, "scripts/eve-code-benchmark.mjs"), "run"], {
      cwd: temp,
      env,
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /TESTED_SHA/);
      assert.doesNotMatch(error.stderr, /ERR_MODULE_NOT_FOUND/);
      return true;
    },
  );
  const results = join(temp, "benchmark-results/results");
  assert.deepEqual(await readdir(results), ["codex-0.json"]);
  const report = JSON.parse(await readFile(join(results, "codex-0.json"), "utf8"));
  assert.deepEqual(report, {
    schemaVersion: 1,
    headSha: "",
    runnerRevision: config.runnerRevision,
    baselineRevision: config.baselineRevision,
    model,
    arm: "codex",
    shard: 0,
    shards: 8,
    dataset,
    trials: [],
    completed: false,
  });
});
