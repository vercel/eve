import { spawn } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const GUARDED_SOURCE = "agent";
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

/** Execute one preplanned fixture/model schedule against already-built variant checkouts. */
export async function runSchedule({
  plan,
  schedule,
  checkouts,
  outputDir,
  env = process.env,
  timeoutMs = 20 * 60_000,
}) {
  const records = [];
  const unsafe = new Set();
  for (const block of schedule.blocks) {
    for (const label of block.order) {
      const variant = plan.variants.find((item) => item.label === label);
      const fixture = plan.fixtures.find((item) => item.name === schedule.fixture);
      const identity = {
        experimentSha: plan.experimentSha,
        manifestHash: plan.manifestHash,
        metricSchemaVersion: plan.metricSchemaVersion,
        variant: label,
        sha: variant.sha,
        configurationExperiment: variant.configurationExperiment ?? false,
        fixture: fixture.name,
        model: schedule.model,
        modelId: schedule.modelId,
        repetition: block.repetition,
        executionOrder: block.order.indexOf(label),
      };
      if (unsafe.has(label)) {
        records.push({
          ...identity,
          correctnessOutcome: "unknown",
          infrastructureError: "Checkout was not reused after an earlier restoration failure.",
        });
      } else {
        const checkout = resolve(checkouts[variant.label] ?? "");
        if (!checkouts[variant.label]) throw new Error(`No prepared checkout for ${variant.label}`);
        const appRoot = join(checkout, "e2e", "fixtures", fixture.name);
        try {
          records.push(await invoke({ appRoot, fixture, identity, outputDir, env, timeoutMs }));
        } catch (error) {
          if (!error.record) throw error;
          records.push(error.record);
          if (
            String(error.message).includes("failed to restore") ||
            String(error.message).includes("checkout lock")
          )
            unsafe.add(label);
        }
      }
      await writeFile(join(outputDir, "invocations.json"), `${JSON.stringify(records, null, 2)}\n`);
    }
  }
  return records;
}

async function invoke({ appRoot, fixture, identity, outputDir, env, timeoutMs }) {
  const id = `${safe(identity.variant)}-${safe(identity.model)}-r${identity.repetition}`;
  const attemptDir = join(
    outputDir,
    "raw",
    safe(fixture.name),
    safe(identity.model),
    `r${identity.repetition}`,
    safe(identity.variant),
  );
  await mkdir(attemptDir, { recursive: true });
  const before = await hashTree(appRoot, GUARDED_SOURCE);
  const start = new Date().toISOString();
  await rm(join(appRoot, ".eve", "evals"), { recursive: true, force: true });
  await mkdir(join(appRoot, ".eve", "evals"), { recursive: true });

  const { AI_GATEWAY_API_KEY: _gatewayKey, ...preparationEnv } = env;
  let prepare = await runProcess("pnpm", ["run", "--if-present", "e2e:prepare"], {
    cwd: appRoot,
    env: preparationEnv,
    timeoutMs: 60_000,
  });
  let result = { exitCode: null, signal: null, timedOut: false, stdout: "", stderr: "" };
  let infrastructureError;
  if (prepare.exitCode !== 0)
    infrastructureError = `Fixture preparation failed (${prepare.exitCode ?? prepare.signal}).`;
  else {
    result = await runProcess(
      "pnpm",
      [
        "exec",
        "eve",
        "eval",
        ...fixture.evals,
        "--strict",
        "--verbose",
        "--max-concurrency",
        "1",
        "--skip-report",
      ],
      {
        cwd: appRoot,
        env: { ...env, EVE_E2E_MODEL: identity.modelId },
        timeoutMs,
      },
    );
    if (result.timedOut) infrastructureError = `Eval invocation exceeded ${timeoutMs}ms.`;
    else if (result.exitCode !== 0 && result.exitCode !== 1)
      infrastructureError = `Eval process failed with exit code ${result.exitCode ?? result.signal}.`;
  }

  const end = new Date().toISOString();
  if (result.stdout) await writeFile(join(attemptDir, "stdout.log"), result.stdout);
  if (result.stderr) await writeFile(join(attemptDir, "stderr.log"), result.stderr);
  const after = await hashTree(appRoot, GUARDED_SOURCE);
  if (before !== after)
    infrastructureError = "Fixture failed to restore authored source; checkout cannot be reused.";
  try {
    await stat(join(appRoot, ".eve-self-modification-eval.lock"));
    infrastructureError =
      "Self-modification checkout lock remains after eval; checkout cannot be reused.";
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let artifact;
  try {
    artifact = await newestArtifact(join(appRoot, ".eve", "evals"));
    if (artifact) await cp(artifact, join(attemptDir, "evals"), { recursive: true });
    else infrastructureError ??= "Eval artifact directory is missing.";
  } catch (error) {
    infrastructureError ??= `Artifact archival failed: ${error.message}`;
  }
  const record = {
    ...identity,
    invocationId: id,
    startedAt: start,
    completedAt: end,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    correctnessOutcome:
      result.exitCode === 0 ? "passed" : result.exitCode === 1 ? "failed" : "unknown",
    infrastructureError,
    modelSettings: await readModelSettings(appRoot),
    buildIdentity: {
      sha: identity.sha,
      eveVersion: await readFile(resolve(appRoot, "../../../packages/eve/package.json"), "utf8")
        .then((text) => JSON.parse(text).version)
        .catch(() => "unknown"),
    },
    selectedEvals: fixture.evals,
    artifact: artifact ? join(attemptDir, "evals") : undefined,
    environment: { node: process.version, platform: process.platform, arch: process.arch },
  };
  await writeFile(join(attemptDir, "invocation.json"), `${JSON.stringify(record, null, 2)}\n`);
  if (infrastructureError) throw Object.assign(new Error(infrastructureError), { record });
  return record;
}

async function readModelSettings(appRoot) {
  const paths = {
    fixtureParent: join(appRoot, "agent/agent.ts"),
    selfModificationAgent: resolve(
      appRoot,
      "../../../packages/eve/src/self-modification/extension/subagents/agent/agent.ts",
    ),
  };
  const values = {};
  for (const [name, path] of Object.entries(paths)) {
    const content = await readFile(path, "utf8").catch(() => "");
    values[name] =
      content.match(/model\s*:\s*([^,\n]+)/)?.[1]?.trim() ?? "not-explicit-in-agent-source";
  }
  return values;
}

async function hashTree(root, relativePath) {
  const hash = createHash("sha256");
  let entries = 0;
  async function visit(path) {
    if (++entries > 512) throw new Error("Fixture authored source exceeds 512 entries.");
    const absolute = join(root, path);
    const info = await stat(absolute).catch((error) =>
      error.code === "ENOENT" ? undefined : Promise.reject(error),
    );
    if (!info) {
      hash.update(`${path}:missing`);
      return;
    }
    if (info.isDirectory()) {
      for (const entry of (await readdir(absolute)).sort()) await visit(join(path, entry));
    } else {
      hash.update(path).update(await readFile(absolute));
    }
  }
  await visit(relativePath);
  return hash.digest("hex");
}
async function newestArtifact(root) {
  const entries = await readdir(root, { withFileTypes: true }).catch((e) =>
    e.code === "ENOENT" ? [] : Promise.reject(e),
  );
  const dirs = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => ({
        path: join(root, entry.name),
        mtime: (await stat(join(root, entry.name))).mtimeMs,
      })),
  );
  dirs.sort((a, b) => b.mtime - a.mtime);
  return dirs[0]?.path;
}
function safe(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function runProcess(command, args, { cwd, env, timeoutMs }) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const collect = (target) => (chunk) => {
      if (target === "stdout") stdout = appendBounded(stdout, chunk);
      else stderr = appendBounded(stderr, chunk);
    };
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    const timer = setTimeout(() => {
      timedOut = true;
      signalProcess(child, "SIGTERM");
      setTimeout(() => signalProcess(child, "SIGKILL"), 5000).unref();
    }, timeoutMs);
    child.on("error", (error) => finish({ error: error.message }));
    child.on("close", (exitCode, signal) => finish({ exitCode, signal }));
    function finish(status) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ ...status, timedOut, stdout, stderr });
    }
  });
}
function signalProcess(child, signal) {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function appendBounded(current, chunk) {
  const next = current + chunk.toString();
  return next.length > MAX_OUTPUT_BYTES ? next.slice(-MAX_OUTPUT_BYTES) : next;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [planPath, scheduleKey, checkoutsPath, outputDir] = process.argv.slice(2);
  if (!planPath || !scheduleKey || !checkoutsPath || !outputDir)
    throw new Error(
      "Usage: node run.mjs <plan.json> <fixture:model> <checkouts.json> <output-dir>",
    );
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  const schedule = plan.matrix.find((item) => `${item.fixture}:${item.model}` === scheduleKey);
  if (!schedule) throw new Error(`No schedule found: ${scheduleKey}`);
  const checkouts = JSON.parse(await readFile(checkoutsPath, "utf8"));
  try {
    await runSchedule({ plan, schedule, checkouts, outputDir: resolve(outputDir) });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
