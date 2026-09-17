import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = "packages/eve-code/extension";
const fixturePath = "apps/fixtures/eve-code-bench";
const shaPattern = /^[a-f0-9]{40}$/;
const namePattern = /^[a-z0-9][a-z0-9.-]*$/;
const providerKeys = [
  "AI_GATEWAY_API_KEY",
  "VERCEL_OIDC_TOKEN",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
];

export function validateConfig(config) {
  for (const key of ["runnerRevision", "baselineRevision"]) assert.match(config[key], shaPattern);
  assert.equal(config.dataset.name, "terminal-bench");
  assert.equal(config.dataset.version, "2.0");
  assert.match(config.dataset.commit, shaPattern);
  assert.equal(config.shards, 8);
  assert.equal(config.attempts, 1);
  assert.equal(config.dataset.tasks.length, 89);
  assert.equal(new Set(config.dataset.tasks).size, 89);
  for (const task of config.dataset.tasks) assert.match(task, namePattern);
  assert.deepEqual(
    config.arms.map((arm) => [arm.id, arm.harness]),
    [
      ["baseline", "e0"],
      ["candidate", "e0"],
      ["codex", "codex"],
      ["claude-code", "claude-code"],
      ["opencode", "opencode"],
      ["hermes", "hermes"],
    ],
  );
  for (const arm of config.arms.filter((arm) => arm.harness !== "e0")) {
    assert.match(arm.version, /^\d+\.\d+\.\d+$/);
  }
  return config;
}

export function shardTasks(config, shard) {
  assert.ok(
    Number.isInteger(shard) && shard >= 0 && shard < config.shards,
    "Invalid zero-based shard",
  );
  return config.dataset.tasks.filter((_, index) => index % config.shards === shard);
}

export function validateDatasetLock(lock, dataset) {
  assert.equal(lock.name, dataset.name);
  assert.equal(lock.version, dataset.version);
  assert.equal(lock.sources.length, 1, "Expected exactly one pinned git dataset source");
  const [source] = lock.sources;
  assert.equal(source.kind, "git");
  assert.equal(source.commit, dataset.commit);
  assert.deepEqual(
    [...source.tasks].sort(),
    [...dataset.tasks].sort(),
    "Dataset tasks differ from config",
  );
  assert.equal(source.corrections?.length ?? 0, 0, "Unexpected dataset corrections");
}

export function runnerArgs({ runner, arm, model, task, job, agent }) {
  return [
    join(runner, "src/cli.ts"),
    "run",
    "--harness",
    arm.harness,
    "--model",
    model,
    "--dataset",
    "terminal-bench",
    "--task",
    task,
    "--attempts",
    "1",
    "--concurrency",
    "1",
    "--job",
    job,
    ...(arm.harness === "e0" ? ["--agent", agent] : []),
  ];
}

export function verifyProvenance(job, result, expected) {
  for (const report of [job, result]) {
    assert.equal(report.job, expected.job, "Job identity mismatch");
    assert.equal(report.harness, expected.arm.harness, "Harness mismatch");
    assert.equal(report.model, expected.model, "Model mismatch");
    assert.deepEqual(report.dataset, expected.dataset, "Dataset mismatch");
  }
  assert.equal(job.attempts, 1);
  assert.deepEqual(job.tasks, [expected.task]);
  assert.equal(result.trials.length, 1);
  const [trial] = result.trials;
  assert.equal(trial.task, expected.task);
  assert.equal(trial.attempt, 1);
  assert.equal(trial.harness, expected.arm.harness);
  assert.equal(trial.model, expected.model);
  if (expected.arm.harness === "e0") {
    assert.equal(job.bundle.model, expected.model);
    for (const key of ["gitSha", "agentSha256", "extensionSha256", "eveDistSha256"]) {
      assert.ok(expected.source?.[key], `Missing expected source ${key}`);
      assert.equal(
        job.bundle.source?.[key],
        expected.source[key],
        `Bundle source mismatch: ${key}`,
      );
    }
  } else {
    const key = {
      codex: "codex",
      "claude-code": "version",
      opencode: "opencodeVersion",
      hermes: "version",
    }[expected.arm.harness];
    assert.ok(expected.arm.version, "Missing pinned harness version");
    assert.equal(job.bundle?.[key], expected.arm.version, "Harness version mismatch");
  }
}

const nonNegative = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;

export function normalizeResult(job, result, expected, { durationMs = 0, exitCode = 0 } = {}) {
  const failed = {
    task: expected.task,
    attempt: 1,
    reward: null,
    durationMs: nonNegative(durationMs) ? durationMs : 0,
    costUsd: null,
    error: true,
  };
  try {
    verifyProvenance(job, result, expected);
    const [trial] = result.trials;
    const elapsed = Date.parse(trial.finishedAt) - Date.parse(trial.startedAt);
    assert.ok(nonNegative(elapsed), "Invalid trial duration");
    for (const step of [trial.agent, trial.verifier]) {
      assert.ok(["completed", "failed", "timeout", "skipped"].includes(step.status));
      assert.ok(nonNegative(step.durationMs));
      assert.ok(step.exitCode === null || (Number.isInteger(step.exitCode) && step.exitCode >= 0));
    }
    assert.ok(trial.reward === null || (nonNegative(trial.reward) && trial.reward <= 1));
    assert.ok(trial.error === undefined || typeof trial.error === "string");
    const costUsd = trial.usage?.costUsd ?? null;
    assert.ok(costUsd === null || nonNegative(costUsd));
    // Verifier exit 1 with a measured reward of 0 is a task failure, not a runner failure.
    const error =
      exitCode !== 0 ||
      trial.reward === null ||
      Boolean(trial.error) ||
      trial.agent.status === "skipped" ||
      trial.verifier.status === "skipped" ||
      trial.verifier.status === "timeout";
    return {
      task: expected.task,
      attempt: 1,
      reward: error ? null : trial.reward,
      durationMs: elapsed,
      costUsd,
      error,
    };
  } catch {
    return failed;
  }
}

export function redactSecrets(text, secrets) {
  const values = secrets.filter(Boolean).sort((a, b) => b.length - a.length);
  const redact = (value) => values.reduce((s, secret) => s.replaceAll(secret, "[REDACTED]"), value);
  try {
    return JSON.stringify(JSON.parse(text), (_, value) =>
      typeof value === "string" ? redact(value) : value,
    );
  } catch {
    return redact(
      values.reduce(
        (s, secret) => s.replaceAll(JSON.stringify(secret).slice(1, -1), "[REDACTED]"),
        text,
      ),
    );
  }
}

async function git(args, cwd = root) {
  return (await exec("git", args, { cwd, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
}

async function archiveExtension(revision, use) {
  const temp = await mkdtemp(join(root, "packages/eve-code/.eve-bench-archive-"));
  try {
    const archive = join(temp, "source.tar");
    await git(["archive", "--format=tar", `--output=${archive}`, revision, "--", extensionPath]);
    await exec("tar", ["-xf", archive, "-C", temp]);
    return await use(join(temp, extensionPath));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function stageBaseline(config) {
  assert.equal(
    await git(["status", "--porcelain", "--untracked-files=all", "--", extensionPath]),
    "",
    "stage-baseline requires a clean extension source tree",
  );
  await archiveExtension(config.baselineRevision, async (source) => {
    await rm(join(root, extensionPath), { recursive: true, force: true });
    await rename(source, join(root, extensionPath));
  });
  console.log(`Staged only ${extensionPath} from ${config.baselineRevision}`);
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value)}\n`, { flag: "wx" });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

async function readDiagnostic(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    assert.ok((await file.stat()).isFile(), "Diagnostic must be a regular file");
    const buffer = Buffer.alloc(4 * 1024 * 1024 + 1);
    let length = 0;
    for (;;) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      length += bytesRead;
      assert.ok(length < buffer.length, "Diagnostic exceeds 4 MiB");
      if (!bytesRead) return buffer.subarray(0, length).toString("utf8");
    }
  } finally {
    await file.close();
  }
}

async function collectDiagnostics(source, destination, secrets) {
  const reports = {};
  await mkdir(destination, { recursive: true });
  for (const name of ["job", "result"]) {
    try {
      const text = await readDiagnostic(join(source, `${name}.json`));
      await writeFile(join(destination, `${name}.json`), `${redactSecrets(text, secrets)}\n`);
      reports[name] = JSON.parse(text);
    } catch (error) {
      console.error(`Unavailable ${name}.json: ${redactSecrets(error.message, secrets)}`);
    }
  }
  return reports;
}

async function run(config) {
  const env = process.env;
  const arm = config.arms.find((entry) => entry.id === env.BENCHMARK_ARM);
  assert.ok(arm, "BENCHMARK_ARM must name a configured arm");
  assert.match(env.BENCHMARK_SHARD ?? "", /^[0-7]$/, "BENCHMARK_SHARD must be 0 through 7");
  const shard = Number(env.BENCHMARK_SHARD);
  const tasks = shardTasks(config, shard);
  const { tasks: _, ...dataset } = config.dataset;
  const report = {
    schemaVersion: 1,
    headSha: env.TESTED_SHA ?? "",
    runnerRevision: config.runnerRevision,
    baselineRevision: config.baselineRevision,
    model: env.BENCHMARK_MODEL ?? "",
    arm: arm.id,
    shard,
    shards: config.shards,
    dataset,
    trials: [],
    completed: false,
  };
  const output = join(root, "benchmark-results");
  const reportPath = join(output, "results", `${arm.id}-${shard}.json`);
  const secrets = providerKeys.map((key) => env[key]).filter(Boolean);
  let stopped;
  let child;
  const stop = (signal) => {
    stopped ??= signal;
    child?.kill(signal);
  };
  const onInt = () => stop("SIGINT");
  const onTerm = () => stop("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  const command = (executable, args, cwd) =>
    new Promise((resolveCommand, reject) => {
      if (stopped) return reject(new Error("Benchmark interrupted"));
      child = spawn(executable, args, { cwd, stdio: "inherit" });
      child.once("error", reject);
      child.once("close", (code) => {
        child = undefined;
        resolveCommand(code);
      });
    });
  let failed = false;
  try {
    await atomicJson(reportPath, report);
    assert.match(report.headSha, shaPattern, "TESTED_SHA must be a full commit SHA");
    assert.ok(report.model.trim() && !/\s/.test(report.model), "BENCHMARK_MODEL is required");
    for (const key of ["GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"])
      assert.match(env[key] ?? "", /^[1-9]\d*$/, `${key} is required`);
    const runner = resolve(root, env.BENCHMARK_RUNNER ?? ".eve-bench-runner");
    assert.equal(
      await git(["rev-parse", "HEAD"]),
      report.headSha,
      "Checkout HEAD differs from TESTED_SHA",
    );
    assert.equal(
      await git(["rev-parse", "HEAD"], runner),
      config.runnerRevision,
      "Runner HEAD differs from config",
    );
    assert.equal(
      await git(
        [
          "status",
          "--porcelain",
          "--untracked-files=all",
          "--",
          "src",
          "datasets",
          "package.json",
          "package-lock.json",
        ],
        runner,
      ),
      "",
      "Runner source must be clean",
    );
    const { lock } = await import(pathToFileURL(join(runner, "src/options.ts")));
    validateDatasetLock(await lock(dataset.name), config.dataset);
    let source;
    const agent = join(root, fixturePath);
    if (arm.harness === "e0") {
      const { assertE0Dependencies } = await import(
        pathToFileURL(join(runner, "src/harnesses/e0/index.ts"))
      );
      const { hashTree } = await import(
        pathToFileURL(join(runner, "src/harnesses/e0/snapshot.ts"))
      );
      await assertE0Dependencies(agent);
      for (const name of ["eve", "eve-code"]) {
        assert.equal(
          await realpath(join(agent, "node_modules", name)),
          await realpath(join(root, "packages", name)),
          `${name} must resolve to this workspace`,
        );
      }
      const extensionSha256 = await hashTree(join(root, extensionPath));
      await archiveExtension(
        arm.id === "baseline" ? config.baselineRevision : report.headSha,
        async (archived) => {
          assert.equal(
            extensionSha256,
            await hashTree(archived),
            "Extension source differs from the configured arm revision",
          );
        },
      );
      source = {
        gitSha: report.headSha,
        agentSha256: await hashTree(join(agent, "agent")),
        extensionSha256,
        eveDistSha256: await hashTree(join(root, "packages/eve/dist")),
      };
    }
    const nonce = randomUUID();
    for (const [index, task] of tasks.entries()) {
      if (stopped) break;
      const job = `ci-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}-${arm.id}-${shard}-${task}-${nonce}`;
      const jobPath = join(runner, ".generated/jobs", job);
      // Reserve the name rather than ever letting the legacy CLI resume a previous trial.
      await mkdir(dirname(jobPath), { recursive: true });
      await mkdir(jobPath);
      const expected = { job, task, arm, model: report.model, dataset, source };
      const started = Date.now();
      let exitCode = 1;
      try {
        exitCode = await command(
          process.execPath,
          runnerArgs({ runner, arm, model: report.model, task, job, agent }),
          runner,
        );
      } catch (error) {
        console.error(redactSecrets(error.message, secrets));
      }
      const raw = await collectDiagnostics(jobPath, join(output, "jobs", job), secrets);
      report.trials.push(
        normalizeResult(raw.job, raw.result, expected, {
          durationMs: Date.now() - started,
          exitCode: stopped ? 1 : exitCode,
        }),
      );
      await atomicJson(reportPath, report);
      if (stopped) break;
      if (index < tasks.length - 1) {
        // These CI workers are disposable and dedicated to one arm/shard.
        assert.equal(
          await command("docker", ["image", "prune", "-af"], root),
          0,
          "Docker image pruning failed",
        );
      }
    }
    report.completed = !stopped && report.trials.length === tasks.length;
  } catch (error) {
    failed = true;
    console.error(`eve-code benchmark: ${redactSecrets(error.message, secrets)}`);
  } finally {
    try {
      await atomicJson(reportPath, report);
    } finally {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
    }
  }
  return stopped
    ? stopped === "SIGINT"
      ? 130
      : 143
    : failed || !report.completed || report.trials.some((trial) => trial.error)
      ? 1
      : 0;
}

if (import.meta.main) {
  try {
    const config = validateConfig(
      JSON.parse(await readFile(join(root, "scripts/eve-code-benchmark-config.json"), "utf8")),
    );
    assert.equal(
      process.argv.length,
      3,
      "Usage: node scripts/eve-code-benchmark.mjs stage-baseline|run",
    );
    if (process.argv[2] === "stage-baseline") await stageBaseline(config);
    else if (process.argv[2] === "run") process.exitCode = await run(config);
    else throw new Error("Usage: node scripts/eve-code-benchmark.mjs stage-baseline|run");
  } catch (error) {
    console.error(
      `eve-code benchmark: ${redactSecrets(
        error.message,
        providerKeys.map((key) => process.env[key]),
      )}`,
    );
    process.exitCode = 1;
  }
}
