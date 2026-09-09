import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const tasksRoot = join(packageRoot, "test", "stress", "tasks");
const jobsRoot = join(packageRoot, ".generated", "jobs");
const timeout = 300_000;

interface StepResult {
  status: "completed" | "timeout" | "failed" | "skipped";
}

interface TrialResult {
  task: string;
  reward: number | null;
  agent: StepResult;
  verifier: StepResult;
  error?: string;
}

interface JobResult {
  dataset: { name: string; version: string; commit: string };
  trials: TrialResult[];
}

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

function taskDir(name: string): string {
  return join(tasksRoot, name);
}

function cliArgs(
  job: string,
  taskDirs: readonly string[],
  extra: readonly string[] = [],
): string[] {
  return [
    "src/cli.ts",
    "run",
    "--harness",
    "oracle",
    "--job",
    job,
    "--json",
    ...taskDirs.flatMap((dir) => ["--task-dir", dir]),
    ...extra,
  ];
}

async function runCli(
  job: string,
  taskDirs: readonly string[],
  extra: readonly string[] = [],
  fresh = true,
): Promise<CliResult> {
  if (fresh) await rm(join(jobsRoot, job), { recursive: true, force: true });
  const started = Date.now();
  const child = spawn(process.execPath, cliArgs(job, taskDirs, extra), {
    cwd: packageRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return collect(child, started);
}

function collect(child: ReturnType<typeof spawn>, started = Date.now()): Promise<CliResult> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      resolvePromise({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        durationMs: Date.now() - started,
      });
    });
  });
}

async function readResult(job: string): Promise<JobResult> {
  return JSON.parse(await readFile(join(jobsRoot, job, "result.json"), "utf8")) as JobResult;
}

async function readTrial(job: string, task: string): Promise<TrialResult> {
  return JSON.parse(
    await readFile(join(jobsRoot, job, task, "1", "trial.json"), "utf8"),
  ) as TrialResult;
}

async function dockerNames(filter: string): Promise<string[]> {
  const result = await runCommand("docker", [
    "ps",
    "-a",
    "--filter",
    `name=eve-bench-${filter}`,
    "--format",
    "{{.Names}}",
  ]);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim() ? result.stdout.trim().split("\n") : [];
}

async function cleanupContainers(filter: string): Promise<void> {
  const names = await dockerNames(filter);
  if (names.length === 0) return;
  const result = await runCommand("docker", ["rm", "--force", ...names]);
  assert.equal(result.code, 0, result.stderr);
}

async function runCommand(command: string, args: readonly string[]): Promise<CliResult> {
  const started = Date.now();
  return collect(
    spawn(command, args, { cwd: packageRoot, stdio: ["ignore", "pipe", "pipe"] }),
    started,
  );
}

async function waitFor(
  condition: () => Promise<boolean>,
  waitMs: number,
  description: string,
): Promise<void> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  assert.fail(`timed out waiting for ${description}`);
}

function assertPassed(result: CliResult): void {
  assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

test("happy: records completed steps and reward 1", { timeout }, async () => {
  const job = "stress-happy";
  await cleanupContainers(job);
  const result = await runCli(job, [taskDir("happy")]);
  assertPassed(result);

  const trial = await readTrial(job, "stress-happy");
  assert.equal(trial.reward, 1);
  assert.equal(trial.agent.status, "completed");
  assert.equal(trial.verifier.status, "completed");
  assert.deepEqual((await readResult(job)).dataset, { name: "local", version: "0", commit: "" });
});

test("agent-timeout: verifier still runs and the container is removed", { timeout }, async () => {
  const job = "stress-agent-timeout";
  await cleanupContainers(job);
  const result = await runCli(job, [taskDir("agent-timeout")]);
  assertPassed(result);

  const trial = await readTrial(job, "stress-agent-timeout");
  assert.equal(trial.agent.status, "timeout");
  assert.equal(trial.verifier.status, "completed");
  assert.equal(trial.reward, 0);
  assert.deepEqual(await dockerNames(job), []);
});

test("verifier-timeout: records timeout and null reward", { timeout }, async () => {
  const job = "stress-verifier-timeout";
  await cleanupContainers(job);
  const result = await runCli(job, [taskDir("verifier-timeout")]);
  assertPassed(result);

  const trial = await readTrial(job, "stress-verifier-timeout");
  assert.equal(trial.agent.status, "completed");
  assert.equal(trial.verifier.status, "timeout");
  assert.equal(trial.reward, null);
});

test(
  "bad-image: records the setup error, skips both steps, and leaves no container",
  { timeout },
  async () => {
    const job = "stress-bad-image";
    await cleanupContainers(job);
    const result = await runCli(job, [taskDir("bad-image")]);
    assertPassed(result);

    const trial = await readTrial(job, "stress-bad-image");
    assert.ok(trial.error);
    assert.equal(trial.agent.status, "skipped");
    assert.equal(trial.verifier.status, "skipped");
    assert.deepEqual(await dockerNames(job), []);
  },
);

test(
  "abort: exits 130, writes a partial result, cleans up, and resumes with a new task set",
  { timeout },
  async () => {
    const job = "stress-abort";
    await cleanupContainers(job);
    await rm(join(jobsRoot, job), { recursive: true, force: true });
    const child = spawn(
      process.execPath,
      cliArgs(job, [taskDir("abort-a"), taskDir("abort-b")], ["--concurrency", "2"]),
      { cwd: packageRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    const completed = collect(child);

    try {
      await waitFor(
        async () => (await dockerNames(job)).length === 2,
        120_000,
        "both abort containers",
      );
      child.kill("SIGINT");
      const aborted = await completed;
      assert.equal(aborted.code, 130, `stdout:\n${aborted.stdout}\nstderr:\n${aborted.stderr}`);

      const partial = await readResult(job);
      assert.ok(partial.trials.length <= 2);
      await waitFor(async () => (await dockerNames(job)).length === 0, 15_000, "abort cleanup");

      const resumed = await runCli(job, [taskDir("abort-resume")], [], false);
      assertPassed(resumed);
      const result = await readResult(job);
      assert.equal(result.trials.length, 1);
      assert.equal(result.trials[0]?.task, "stress-abort-resume");
      assert.equal(result.trials[0]?.reward, 1);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await cleanupContainers(job);
    }
  },
);

test(
  "concurrency: six trials finish substantially faster than serial execution",
  { timeout },
  async () => {
    const dirs = Array.from({ length: 6 }, (_, index) => taskDir(`concurrency-${index + 1}`));
    await cleanupContainers("stress-concurrency");

    const single = await runCli("stress-concurrency-single", [dirs[0]!], ["--concurrency", "1"]);
    assertPassed(single);
    const concurrent = await runCli("stress-concurrency", dirs, ["--concurrency", "6"]);
    assertPassed(concurrent);

    const result = await readResult("stress-concurrency");
    assert.equal(result.trials.length, 6);
    assert.deepEqual(
      result.trials.map((trial) => trial.reward),
      [1, 1, 1, 1, 1, 1],
    );
    assert.ok(
      concurrent.durationMs < single.durationMs * 3,
      `single=${single.durationMs}ms concurrent=${concurrent.durationMs}ms`,
    );
  },
);
