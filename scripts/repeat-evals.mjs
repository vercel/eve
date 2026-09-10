import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import {
  MAX_EVAL_OUTPUT_BYTES,
  parseEvalSummary,
  validateEvalIds,
  zeroFailureUpperBound95,
} from "./flake-validation-results.mjs";

const repetitions = Number(process.env.EVE_E2E_REPETITIONS);
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 500) {
  throw new Error("EVE_E2E_REPETITIONS must be an integer from 1 to 500.");
}
const timeoutMs = Number(process.env.EVE_E2E_TRIAL_TIMEOUT_MS ?? 10 * 60_000);
if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30 * 60_000) {
  throw new Error("EVE_E2E_TRIAL_TIMEOUT_MS must be an integer from 1000 to 1800000.");
}
const evalIds = (process.env.EVE_E2E_EVAL_IDS ?? "").split(/\s+/).filter(Boolean);
const expectedEvalIds = (process.env.EVE_E2E_EXPECTED_EVAL_IDS ?? "").split(/\s+/).filter(Boolean);
validateEvalIds(evalIds, { required: false });
validateEvalIds(expectedEvalIds);
const model = process.env.EVE_E2E_MODEL;
if (!model || model.length > 256 || !/^[a-zA-Z0-9._/-]+$/.test(model)) {
  throw new Error("EVE_E2E_MODEL must explicitly identify the model under test.");
}
if (!process.env.EVE_EVAL_JUNIT_DIR) {
  throw new Error("EVE_EVAL_JUNIT_DIR is required for repetition evidence.");
}
const requestedRef = process.env.EVE_E2E_REF ?? "HEAD";
if (requestedRef.length > 1_024 || requestedRef.length === 0) {
  throw new Error("EVE_E2E_REF must be a nonempty git revision of at most 1024 characters.");
}
const shard = process.env.EVE_E2E_REPETITION_SHARD;
if (
  shard !== undefined &&
  (shard.length === 0 || shard.length > 64 || !/^[a-zA-Z0-9._/-]+$/.test(shard))
) {
  throw new Error(
    "EVE_E2E_REPETITION_SHARD must be a plain shard identifier of at most 64 characters.",
  );
}

const exec = promisify(execFile);
const sourceRoot = resolve(process.env.EVE_E2E_REPO_ROOT ?? resolve(import.meta.dirname, ".."));
async function git(...args) {
  const { stdout } = await exec("git", args, {
    cwd: sourceRoot,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
    killSignal: "SIGKILL",
  });
  return stdout.trim();
}

// The harness may be loaded from a different checkout during baseline/candidate comparisons.
const repositoryRoot = await git("rev-parse", "--show-toplevel");
const actualHead = await git("rev-parse", "--verify", "HEAD");
const resolvedRef = await git(
  "rev-parse",
  "--verify",
  "--end-of-options",
  `${requestedRef}^{commit}`,
);
if (actualHead !== resolvedRef) {
  throw new Error(`EVE_E2E_REF resolves to ${resolvedRef}, but checkout HEAD is ${actualHead}.`);
}
const cli = resolve(repositoryRoot, "packages/eve/bin/eve.js");
const root = resolve(process.env.EVE_EVAL_JUNIT_DIR);
const directory = resolve(root, "repetitions");
await mkdir(root, { recursive: true });
// Reusing an evidence directory must never overwrite an earlier experiment.
await mkdir(directory);
const metadata = {
  requestedRef,
  resolvedRef,
  actualHead,
  trackedWorktreeDirty: (await git("status", "--porcelain", "--untracked-files=no")).length > 0,
  githubSha: process.env.GITHUB_SHA,
  githubRef: process.env.GITHUB_REF,
  githubRunId: process.env.GITHUB_RUN_ID,
  githubRunAttempt: process.env.GITHUB_RUN_ATTEMPT,
  model,
  shard,
  repositoryRoot,
  nodeVersion: process.version,
  fixtureDirectory: process.cwd(),
  cli,
  runnerSha256: createHash("sha256")
    .update(await readFile(new URL(import.meta.url)))
    .digest("hex"),
  parserSha256: createHash("sha256")
    .update(await readFile(new URL("./flake-validation-results.mjs", import.meta.url)))
    .digest("hex"),
  evalIds,
  expectedEvalIds,
  startedAt: new Date().toISOString(),
  repetitions,
  timeoutMs,
  maxOutputBytes: MAX_EVAL_OUTPUT_BYTES,
  scope:
    "One trial is one complete fresh CLI run of exactly the expected eval IDs under --strict. " +
    "The zero-failure bound applies only to final trial failures in a completed, fixed-count run, " +
    "assuming independent, stationary Bernoulli trials. Fresh processes do not establish independence " +
    "across a shared provider, caches, or changing load. This is not a per-request refusal-rate bound " +
    "or proof of a causal baseline/candidate difference.",
};
const trials = [];
await saveProgress();

for (let index = 0; index < repetitions; index += 1) {
  const name = String(index + 1).padStart(4, "0");
  const prefix = resolve(directory, name);
  const args = [
    cli,
    "eval",
    ...evalIds,
    "--strict",
    "--json",
    "--skip-report",
    "--junit",
    `${prefix}.xml`,
  ];
  const startedAt = new Date().toISOString();
  const result = await runProcess(args);
  await writeFile(`${prefix}.stdout.log`, result.stdout);
  await writeFile(`${prefix}.stderr.log`, result.stderr);
  const { summary, ...analysis } = parseEvalSummary(result.stdout, expectedEvalIds);
  if (summary !== undefined) await writeJson(`${prefix}.summary.json`, summary);
  const { stdout: _stdout, stderr: _stderr, ...processResult } = result;
  const trial = {
    repetition: index + 1,
    startedAt,
    completedAt: new Date().toISOString(),
    ...analysis,
    passed: result.exitCode === 0 && result.error === undefined && analysis.passed,
    process: processResult,
    stdoutFile: `${name}.stdout.log`,
    stderrFile: `${name}.stderr.log`,
    summaryFile: summary === undefined ? null : `${name}.summary.json`,
    junitFile: `${name}.xml`,
  };
  trials.push(trial);
  await writeJson(`${prefix}.trial.json`, trial);
  await saveProgress();
  console.log(
    `${index + 1}/${repetitions} repetitions; ${trials.filter((trial) => !trial.passed).length} failures`,
  );
}
process.exitCode = trials.every((trial) => trial.passed) ? 0 : 1;

async function saveProgress() {
  const complete = trials.length === repetitions;
  const failures = trials.filter((trial) => !trial.passed).length;
  await writeJson(resolve(directory, "trials.json"), trials);
  const report = {
    ...metadata,
    complete,
    completedRepetitions: trials.length,
    updatedAt: new Date().toISOString(),
    failures,
    confidence: 0.95,
    oneSidedFailureRateUpperBound:
      complete && failures === 0 ? zeroFailureUpperBound95(repetitions) : null,
  };
  await writeJson(resolve(directory, "summary.json"), report);
  if (complete) console.log(JSON.stringify(report, null, 2));
}

async function writeJson(path, value) {
  await writeFile(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  await rename(`${path}.tmp`, path);
}

function runProcess(args) {
  return new Promise((resolveResult) => {
    const grouped = process.platform !== "win32";
    const child = spawn(process.execPath, args, {
      detached: grouped,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = { stdout: [], stderr: [] };
    let bytes = 0;
    let error;
    function terminate(reason) {
      error ??= reason;
      try {
        if (grouped && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch (failure) {
        if (failure.code !== "ESRCH") error += `; termination failed: ${failure.message}`;
      }
    }
    for (const name of ["stdout", "stderr"]) {
      child[name].on("data", (chunk) => {
        const retained = chunk.subarray(0, Math.max(0, MAX_EVAL_OUTPUT_BYTES - bytes));
        output[name].push(retained);
        bytes += retained.length;
        if (retained.length < chunk.length)
          terminate("Combined stdout/stderr exceeded the output limit; logs are truncated.");
      });
    }
    const timer = setTimeout(
      () => terminate(`CLI exceeded the ${timeoutMs}ms trial timeout.`),
      timeoutMs,
    );
    child.once("error", (failure) => {
      error ??= failure.message;
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolveResult({
        stdout: Buffer.concat(output.stdout).toString("utf8"),
        stderr: Buffer.concat(output.stderr).toString("utf8"),
        exitCode,
        signal,
        error:
          error ??
          (exitCode === 0 ? undefined : `CLI exited with code ${exitCode}, signal ${signal}.`),
        retainedOutputBytes: bytes,
      });
    });
  });
}
