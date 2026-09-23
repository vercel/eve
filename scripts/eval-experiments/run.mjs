import { spawn } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const EXPERIMENT_ENV = [
  "EVE_E2E_MODEL",
  "EVE_E2E_REASONING",
  "EVE_EVAL_EXPERIMENT",
  "EVE_EXPERIMENT_PARENT_MODEL",
  "EVE_EXPERIMENT_PARENT_REASONING",
  "EVE_EXPERIMENT_SELF_MODIFICATION_MODEL",
  "EVE_EXPERIMENT_SELF_MODIFICATION_REASONING",
];

export async function runSchedule({
  plan,
  checkouts,
  outputDir,
  env = process.env,
  timeoutMs = 20 * 60_000,
  verifyCheckout,
}) {
  const records = [];
  const unsafe = new Set();
  for (const cell of plan.schedule) {
    const source = plan.sources.find((item) => item.label === cell.source);
    const configuration = plan.configurations.find((item) => item.label === cell.configuration);
    const fixture = plan.fixtures.find((item) => item.name === cell.fixture);
    const identity = {
      planHash: plan.planHash,
      experimentRevision: plan.experimentRevision,
      source: cell.source,
      sourceSha: source.sha,
      configuration: cell.configuration,
      settings: configuration.settings,
      fixture: fixture.name,
      eval: cell.eval,
      scheduleIdentity: { [cell.eval]: { ...cell, settings: configuration.settings } },
      repetition: cell.repetition,
      executionOrder: cell.executionOrder,
    };
    if (unsafe.has(cell.source)) {
      records.push({
        ...identity,
        correctnessOutcome: "unknown",
        infrastructureError: "Checkout quarantined after a restoration failure.",
        restoration: "failed",
      });
    } else {
      const checkout = resolve(checkouts[cell.source] ?? "");
      if (!checkouts[cell.source]) throw new Error(`No prepared checkout for ${cell.source}`);
      try {
        records.push(
          await invoke({ checkout, fixture, identity, outputDir, env, timeoutMs, verifyCheckout }),
        );
      } catch (error) {
        if (!error.record) throw error;
        records.push(error.record);
        if (error.record.restoration === "failed") unsafe.add(cell.source);
      }
    }
    await writeFile(join(outputDir, "invocations.json"), `${JSON.stringify(records, null, 2)}\n`);
  }
  return records;
}

async function invoke({ checkout, fixture, identity, outputDir, env, timeoutMs, verifyCheckout }) {
  const appRoot = join(checkout, "e2e", "fixtures", fixture.name);
  const attemptDir = join(
    outputDir,
    "raw",
    safe(identity.fixture),
    safe(identity.configuration),
    `r${identity.repetition}`,
    safe(identity.source),
    safe(identity.eval),
  );
  await mkdir(attemptDir, { recursive: true });
  const adapter = await loadFixtureAdapter(appRoot, fixture.name, identity.settings);
  const cleanEnv = Object.fromEntries(
    Object.entries(env).filter(([key]) => !EXPERIMENT_ENV.includes(key)),
  );
  const runEnv = { ...cleanEnv, EVE_EVAL_EXPERIMENT: "1", ...adapter.environment };
  const start = new Date().toISOString();
  await rm(join(appRoot, ".eve", "evals"), { recursive: true, force: true });
  await mkdir(join(appRoot, ".eve", "evals"), { recursive: true });
  let infrastructureError;
  let result = { exitCode: null, signal: null, timedOut: false, stdout: "", stderr: "" };
  let before;
  const prepare = await runProcess("pnpm", ["run", "--if-present", "e2e:prepare"], {
    cwd: appRoot,
    env: runEnv,
    timeoutMs: 60_000,
  });
  if (prepare.exitCode !== 0)
    infrastructureError = `Fixture preparation failed (${prepare.exitCode ?? prepare.signal}).`;
  else {
    before = await hashTree(appRoot, adapter.guardedPath);
    result = await runProcess(
      "pnpm",
      [
        "exec",
        "eve",
        "eval",
        identity.eval,
        "--strict",
        "--verbose",
        "--max-concurrency",
        "1",
        "--skip-report",
      ],
      { cwd: appRoot, env: runEnv, timeoutMs },
    );
    if (result.timedOut) infrastructureError = `Eval invocation exceeded ${timeoutMs}ms.`;
    else if (result.exitCode !== 0 && result.exitCode !== 1)
      infrastructureError = `Eval process failed (${result.exitCode ?? result.signal}).`;
  }
  const after = await hashTree(appRoot, adapter.guardedPath);
  const restored = before === undefined || before === after;
  let cleanupSafe = false;
  try {
    cleanupSafe = await (verifyCheckout ?? adapter.verifyCheckout)(appRoot);
  } catch {
    cleanupSafe = false;
  }
  const restoration = restored && cleanupSafe ? "verified" : "failed";
  if (restoration === "failed")
    infrastructureError = "Fixture restoration or cleanup verification failed.";
  const end = new Date().toISOString();
  if (result.stdout) await writeFile(join(attemptDir, "stdout.log"), result.stdout);
  if (result.stderr) await writeFile(join(attemptDir, "stderr.log"), result.stderr);
  let artifactDirectory;
  try {
    artifactDirectory = await newestArtifact(join(appRoot, ".eve", "evals"));
    if (artifactDirectory)
      await cp(artifactDirectory, join(attemptDir, "evals"), { recursive: true });
    else infrastructureError ??= "Eval artifact directory is missing.";
  } catch (error) {
    infrastructureError ??= `Artifact archival failed: ${error.message}`;
  }
  const record = {
    ...identity,
    invocationId: `${safe(identity.source)}-${safe(identity.configuration)}-r${identity.repetition}-${safe(identity.eval)}`,
    startedAt: start,
    completedAt: end,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    correctnessOutcome:
      result.exitCode === 0 ? "passed" : result.exitCode === 1 ? "failed" : "unknown",
    infrastructureError,
    restoration,
    requestedSettings: identity.settings,
    runtimeObservations: { models: "captured-from-events", reasoning: "not-observed" },
    selectedEvals: [identity.eval],
    scheduleIdentity: identity.scheduleIdentity,
    artifact: artifactDirectory
      ? join(
          "raw",
          safe(identity.fixture),
          safe(identity.configuration),
          `r${identity.repetition}`,
          safe(identity.source),
          safe(identity.eval),
          "evals",
          artifactDirectory.split("/").at(-1),
        )
      : undefined,
    environment: { node: process.version, platform: process.platform, arch: process.arch },
  };
  await writeFile(join(attemptDir, "invocation.json"), `${JSON.stringify(record, null, 2)}\n`);
  if (infrastructureError) throw Object.assign(new Error(infrastructureError), { record });
  return record;
}

async function loadFixtureAdapter(appRoot, fixtureName, settings) {
  if (fixtureName !== "agent-self-modification")
    throw new Error(`Unsupported experiment fixture adapter: ${fixtureName}`);
  const prepareSource = await readFile(join(appRoot, "scripts/prepare.mjs"), "utf8");
  const parentSource = await readFile(join(appRoot, "agent/agent.ts"), "utf8");
  if (
    !["EVE_EXPERIMENT_SELF_MODIFICATION_MODEL", "EVE_EXPERIMENT_SELF_MODIFICATION_REASONING"].every(
      (name) => prepareSource.includes(name),
    ) ||
    !parentSource.includes("EVE_EXPERIMENT_PARENT_MODEL") ||
    !parentSource.includes("EVE_EXPERIMENT_PARENT_REASONING")
  )
    throw new Error(`Fixture checkout ${fixtureName} does not support scoped experiment settings.`);
  const environment = {};
  for (const [scope, prefix] of [
    ["parent", "EVE_EXPERIMENT_PARENT"],
    ["selfModification", "EVE_EXPERIMENT_SELF_MODIFICATION"],
  ]) {
    const value = settings?.[scope] ?? {};
    if (value.model !== undefined) environment[`${prefix}_MODEL`] = value.model;
    if (value.reasoning !== undefined) environment[`${prefix}_REASONING`] = value.reasoning;
  }
  return {
    environment,
    guardedPath: "agent",
    verifyCheckout: async (root) => {
      try {
        await stat(join(root, ".eve-self-modification-eval.lock"));
        return false;
      } catch (error) {
        if (error.code === "ENOENT") return true;
        throw error;
      }
    },
  };
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
    if (info.isDirectory())
      for (const entry of (await readdir(absolute)).sort()) await visit(join(path, entry));
    else hash.update(path).update(await readFile(absolute));
  }
  await visit(relativePath);
  return hash.digest("hex");
}
async function newestArtifact(root) {
  const entries = await readdir(root, { withFileTypes: true }).catch((error) =>
    error.code === "ENOENT" ? [] : Promise.reject(error),
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
    let stdout = "",
      stderr = "",
      timedOut = false,
      settled = false;
    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk);
    });
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
  const [planPath, checkoutsPath, outputDir] = process.argv.slice(2);
  if (!planPath || !checkoutsPath || !outputDir)
    throw new Error("Usage: node run.mjs <plan.json> <checkouts.json> <output-dir>");
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  const checkouts = JSON.parse(await readFile(checkoutsPath, "utf8"));
  try {
    await runSchedule({ plan, checkouts, outputDir: resolve(outputDir) });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
