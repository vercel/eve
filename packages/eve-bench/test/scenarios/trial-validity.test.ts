import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test, type TestContext } from "node:test";

import type { Harness } from "../../src/core/harness.ts";
import { runJob } from "../../src/core/job.ts";
import type { JobResult, TrialResult } from "../../src/core/result.ts";
import { loadTask } from "../../src/core/task.ts";
import { readCliUsage } from "../../src/harnesses/cli/usage.ts";

/** Files the harness and verifier leave in the container; null leaves the directory absent. */
interface ContainerLogs {
  readonly agent: Readonly<Record<string, string>> | null;
  readonly verifier: Readonly<Record<string, string>> | null;
}

interface Scenario {
  readonly logs: ContainerLogs;
  readonly buildFails?: boolean;
  readonly agentTimeoutSec?: number;
  readonly agentRunsMs?: number;
  readonly modelFree?: boolean;
}

// pi --mode json records one assistant message_end per model call; a rejected key records zero usage.
const piCall = (input: number, output: number) =>
  `${JSON.stringify({
    type: "message_end",
    message: { role: "assistant", usage: { input, output, cacheRead: 0, cost: { total: 0 } } },
  })}\n`;
const reward = (value: string) => ({ "reward.txt": `${value}\n` });

async function runScenario(t: TestContext, scenario: Scenario) {
  const root = await mkdtemp(join(tmpdir(), "eve-bench-validity-"));
  const bin = join(root, "bin");
  const fs = join(root, "container");
  const taskDir = join(root, "tasks", "a");
  await mkdir(bin);
  for (const dir of ["environment", "tests"]) await mkdir(join(taskDir, dir), { recursive: true });
  await writeFile(join(taskDir, "instruction.md"), "Do the task.\n");
  await writeFile(
    join(taskDir, "task.toml"),
    `[task]\nname = "a"\n${scenario.agentTimeoutSec ? `[agent]\ntimeout_sec = ${scenario.agentTimeoutSec}\n` : ""}`,
  );
  await writeFile(join(taskDir, "environment", "Dockerfile"), "FROM scratch\n");
  await writeFile(join(taskDir, "tests", "test.sh"), "true\n");
  for (const [dir, files] of Object.entries(scenario.logs)) {
    if (files === null) continue;
    await mkdir(join(fs, "logs", dir), { recursive: true });
    for (const [name, content] of Object.entries(files))
      await writeFile(join(fs, "logs", dir, name), content);
  }
  // No daemon or model: copying out of the container serves the scripted log tree.
  await writeFile(
    join(bin, "docker"),
    `#!${process.execPath}
import { cpSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
const args = process.argv.slice(2);
const fail = (message) => { process.stderr.write(message + '\\n'); process.exit(1); };
switch (args[0]) {
  case 'version': console.log('fake-docker'); break;
  case 'image': process.exit(1);
  case 'build': if (${scenario.buildFails === true}) fail('fake build failed'); break;
  case 'exec': {
    const command = args.at(-1);
    if (command === 'pwd') console.log('/workspace');
    if (command === 'run-agent') await new Promise((r) => setTimeout(r, ${scenario.agentRunsMs ?? 0}));
    break;
  }
  case 'cp': {
    const [source, target] = args.slice(1);
    const match = /^[^/][^:]*:(\\/.*)$/.exec(source);
    if (!match) break;
    const from = join(${JSON.stringify(fs)}, match[1]);
    if (!existsSync(from)) fail('No such container path: ' + match[1]);
    cpSync(from, join(target, basename(from)), { recursive: true });
    break;
  }
}
`,
    { mode: 0o755 },
  );
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  t.after(async () => {
    process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  });
  const harness: Harness = {
    name: "fake",
    modelFree: scenario.modelFree === true,
    prepare: async () => ({ dir: bin, provenance: { key: "v1" } }),
    command: () => "run-agent",
    env: () => ({}),
    readUsage: (dir) => readCliUsage("pi", dir),
  };
  const dir = join(root, "job");
  const result: JobResult = await runJob({
    name: basename(root),
    dir,
    cacheDir: join(root, "cache"),
    dataset: { name: "local", version: "0", gitUrl: "", commit: "", tasks: ["a"] },
    tasks: [await loadTask(taskDir)],
    harness,
    model: "test/model",
    attempts: 1,
    concurrency: 1,
    forwardEnv: {},
    signal: new AbortController().signal,
  });
  const saved = JSON.parse(
    await readFile(join(dir, "a", "1", "trial.json"), "utf8"),
  ) as TrialResult;
  assert.deepEqual(saved, result.trials[0], "trial.json must record the classification");
  return { trial: saved, summary: result.summary };
}

test("a trial with a completed model call and a reward is scored", async (t) => {
  const { trial, summary } = await runScenario(t, {
    logs: { agent: { "pi.jsonl": piCall(100, 20) + piCall(50, 5) }, verifier: reward("1") },
  });
  assert.equal(trial.invalid, undefined);
  assert.deepEqual(trial.usage, {
    inputTokens: 150,
    outputTokens: 25,
    cachedTokens: 0,
    costUsd: null,
  });
  assert.deepEqual(summary, {
    tasks: 1,
    attempts: 1,
    scored: 1,
    invalid: { environment: 0, harness: 0, verifier: 0 },
    resolved: 1,
    meanReward: 1,
  });
});

test("a harness whose model calls all failed is invalid, not a task failure", async (t) => {
  const { trial, summary } = await runScenario(t, {
    logs: { agent: { "pi.jsonl": `not json\n${piCall(0, 0)}` }, verifier: reward("0") },
  });
  assert.equal(trial.invalid?.phase, "harness");
  assert.match(trial.invalid!.reason, /zero token usage/);
  assert.deepEqual(summary.invalid, { environment: 0, harness: 1, verifier: 0 });
  assert.equal(summary.scored, 0);
  assert.equal(summary.meanReward, null);
});

test("a harness that logged no usage is invalid even when the verifier passes", async (t) => {
  const { trial } = await runScenario(t, { logs: { agent: {}, verifier: reward("1") } });
  assert.equal(trial.reward, 1);
  assert.equal(trial.invalid?.phase, "harness");
  assert.match(trial.invalid!.reason, /no model usage/);
});

test("a model-free harness needs no usage to be scored", async (t) => {
  const { trial } = await runScenario(t, {
    modelFree: true,
    logs: { agent: {}, verifier: reward("1") },
  });
  assert.equal(trial.invalid, undefined);
});

test("an agent timeout after model calls is scored against the harness", async (t) => {
  const { trial, summary } = await runScenario(t, {
    agentTimeoutSec: 0.3,
    agentRunsMs: 5_000,
    logs: { agent: { "pi.jsonl": piCall(10, 1) }, verifier: reward("0") },
  });
  assert.equal(trial.agent.status, "timeout");
  assert.equal(trial.invalid, undefined);
  assert.equal(trial.usage?.inputTokens, 10);
  assert.equal(summary.scored, 1);
  assert.equal(summary.meanReward, 0);
});

test("a missing reward is a verifier failure", async (t) => {
  const { trial } = await runScenario(t, {
    logs: { agent: { "pi.jsonl": piCall(10, 1) }, verifier: {} },
  });
  assert.equal(trial.reward, null);
  assert.deepEqual(trial.invalid, { phase: "verifier", reason: "verifier wrote no reward" });
});

test("undownloadable agent logs are an environment failure", async (t) => {
  const { trial } = await runScenario(t, { logs: { agent: null, verifier: reward("1") } });
  assert.equal(trial.agent.status, "completed");
  assert.equal(trial.invalid?.phase, "environment");
  assert.match(
    trial.invalid!.reason,
    /after the harness started: could not download \/logs\/agent/,
  );
});

test("an image build failure is an environment failure before the harness starts", async (t) => {
  const { trial, summary } = await runScenario(t, {
    buildFails: true,
    logs: { agent: { "pi.jsonl": piCall(10, 1) }, verifier: reward("1") },
  });
  assert.equal(trial.agent.status, "skipped");
  assert.equal(trial.invalid?.phase, "environment");
  assert.match(trial.invalid!.reason, /before the harness started: .*fake build failed/);
  assert.deepEqual(summary.invalid, { environment: 1, harness: 0, verifier: 0 });
});
