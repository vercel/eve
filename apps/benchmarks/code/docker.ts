import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import type {
  HarnessBundle,
  HarnessRunContext,
  ReasoningLevel,
  StepOutcome,
  TaskSpec,
  TrialOverhead,
  TrialResult,
  TrialUsage,
} from "./types.ts";

const exec = promisify(execFile);

const INSTALL_DIR = "/installed-agent";
const LOGS_DIR = "/logs";
const TESTS_DIR = "/tests";

async function dockerRun(args: readonly string[], timeoutMs = 120_000): Promise<string> {
  const { stdout } = await exec("docker", [...args], {
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

async function execInContainer(
  containerId: string,
  command: string,
  options: {
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
    readonly logPath?: string;
  },
): Promise<StepOutcome> {
  const startedAt = Date.now();
  const args = ["exec"];
  if (options.cwd) args.push("-w", options.cwd);
  for (const [key, value] of Object.entries(options.env ?? {})) {
    args.push("-e", `${key}=${value}`);
  }
  args.push(containerId, "sh", "-c", command);

  const logStream = options.logPath
    ? createWriteStream(options.logPath, { flags: "a" })
    : undefined;
  const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
  if (logStream) {
    child.stdout.pipe(logStream);
    child.stderr.pipe(logStream);
  } else {
    child.stdout.resume();
    child.stderr.resume();
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, options.timeoutMs);

  const exitCode = await new Promise<number | null>((resolveExit) => {
    child.once("close", (code) => resolveExit(code));
  });
  clearTimeout(timer);
  logStream?.end();

  const durationMs = Date.now() - startedAt;
  if (timedOut) return { status: "timeout", exitCode, durationMs };
  return { status: exitCode === 0 ? "completed" : "failed", exitCode, durationMs };
}

async function copyIntoContainer(containerId: string, src: string, dest: string): Promise<void> {
  await dockerRun(["cp", src, `${containerId}:${dest}`], 120_000);
}

async function copyFromContainer(containerId: string, src: string, dest: string): Promise<boolean> {
  try {
    await mkdir(dirname(dest), { recursive: true });
    await dockerRun(["cp", `${containerId}:${src}`, dest], 120_000);
    return true;
  } catch {
    return false;
  }
}

async function resolveContainerArch(containerId: string): Promise<"x64" | "arm64"> {
  const out = (await dockerRun(["exec", containerId, "uname", "-m"], 15_000)).trim();
  return out === "aarch64" || out === "arm64" ? "arm64" : "x64";
}

async function resolveContainerWorkdir(containerId: string): Promise<string> {
  const out = (
    await dockerRun(["inspect", "--format", "{{.Config.WorkingDir}}", containerId], 15_000)
  ).trim();
  return out || "/app";
}

async function resolveTaskImage(task: TaskSpec): Promise<string> {
  if (task.dockerImage) {
    await dockerRun(["pull", "--quiet", task.dockerImage], 15 * 60 * 1000);
    return task.dockerImage;
  }
  const tag = `code-bench-${task.name}:${randomUUID().slice(0, 8)}`;
  await dockerRun(["build", "--quiet", "-t", tag, join(task.dir, "environment")], 15 * 60 * 1000);
  return tag;
}

async function startContainer(
  image: string,
  task: TaskSpec,
  options: { readonly networkDisabled?: boolean } = {},
): Promise<string> {
  const args = ["run", "-d", "--init", `--cpus=${task.cpus}`, `--memory=${task.memoryMb}m`];
  if (options.networkDisabled) args.push("--network=none");
  for (const [key, value] of Object.entries(task.env)) {
    args.push("-e", `${key}=${value}`);
  }
  args.push(image, "sh", "-c", "trap 'exit 0' TERM INT; sleep infinity & wait");
  return (await dockerRun(args, 60_000)).trim();
}

async function removeContainer(containerId: string | undefined): Promise<void> {
  if (!containerId) return;
  await dockerRun(["rm", "-f", containerId], 30_000).catch(() => {});
}

async function readReward(verifierDir: string): Promise<number | null> {
  const jsonPath = join(verifierDir, "reward.json");
  try {
    const parsed = JSON.parse(await readFile(jsonPath, "utf8")) as { reward?: unknown };
    if (typeof parsed.reward === "number" && Number.isFinite(parsed.reward)) {
      return parsed.reward;
    }
  } catch {}
  const txtPath = join(verifierDir, "reward.txt");
  try {
    const num = Number((await readFile(txtPath, "utf8")).trim());
    if (Number.isFinite(num)) return num;
  } catch {}
  return null;
}

async function readAgentTelemetry(agentDir: string): Promise<{
  readonly usage?: TrialUsage;
  readonly overhead?: TrialOverhead;
  readonly status?: StepOutcome["status"];
  readonly durationMs?: number;
}> {
  try {
    const raw = JSON.parse(await readFile(join(agentDir, "result.json"), "utf8")) as {
      usage?: TrialUsage;
      overhead?: TrialOverhead;
      status?: StepOutcome["status"];
      durationMs?: number;
    };
    return raw;
  } catch {
    return {};
  }
}

export async function runDockerTrial(input: {
  readonly task: TaskSpec;
  readonly attempt: number;
  readonly bundle: HarnessBundle;
  readonly model: string;
  readonly reasoning: ReasoningLevel;
  readonly trialDir: string;
  readonly forwardEnv: Readonly<Record<string, string>>;
}): Promise<TrialResult> {
  const { task, attempt, bundle, model, reasoning, trialDir, forwardEnv } = input;
  const startedAt = new Date().toISOString();
  await mkdir(trialDir, { recursive: true });

  let agentContainer: string | undefined;
  let verifierContainer: string | undefined;
  let agent: StepOutcome = { status: "skipped", exitCode: null, durationMs: 0 };
  let verifier: StepOutcome = { status: "skipped", exitCode: null, durationMs: 0 };
  let reward: number | null = null;
  let error: string | undefined;

  try {
    const image = await resolveTaskImage(task);
    agentContainer = await startContainer(image, task);
    const workdir = await resolveContainerWorkdir(agentContainer);
    const arch = await resolveContainerArch(agentContainer);

    await execInContainer(
      agentContainer,
      `mkdir -p ${INSTALL_DIR} ${INSTALL_DIR}/arch ${LOGS_DIR}/agent ${LOGS_DIR}/verifier ${LOGS_DIR}/artifacts ${TESTS_DIR}`,
      { timeoutMs: 30_000 },
    );

    await copyIntoContainer(agentContainer, `${bundle.dir}/.`, INSTALL_DIR);
    if (bundle.archDirs) {
      await copyIntoContainer(agentContainer, `${bundle.archDirs[arch]}/.`, `${INSTALL_DIR}/arch`);
    }
    const localInstruction = join(trialDir, "instruction.md");
    await writeFile(localInstruction, task.instruction);
    await copyIntoContainer(agentContainer, localInstruction, `${INSTALL_DIR}/instruction.md`);

    const runCtx: HarnessRunContext = {
      installDir: INSTALL_DIR,
      instructionPath: `${INSTALL_DIR}/instruction.md`,
      logsDir: `${LOGS_DIR}/agent`,
      taskWorkdir: workdir,
      model,
      reasoning,
      agentTimeoutMs: task.agentTimeoutSec * 1000,
    };

    agent = await execInContainer(agentContainer, bundle.command(runCtx), {
      cwd: workdir,
      env: { ...forwardEnv, ...bundle.env(runCtx) },
      timeoutMs: task.agentTimeoutSec * 1000 + 15_000,
      logPath: join(trialDir, "agent.log"),
    });

    for (const hook of task.collectHooks) {
      await execInContainer(agentContainer, hook.command, {
        cwd: workdir,
        timeoutMs: hook.timeoutSec * 1000,
        logPath: join(trialDir, "collect.log"),
      });
    }

    await copyFromContainer(agentContainer, `${LOGS_DIR}/agent`, join(trialDir, "agent"));

    if (task.separateVerifier) {
      const localArtifacts = join(trialDir, "artifacts");
      await copyFromContainer(agentContainer, `${LOGS_DIR}/artifacts`, localArtifacts);
      await removeContainer(agentContainer);
      agentContainer = undefined;

      verifierContainer = await startContainer(image, task, { networkDisabled: true });
      await execInContainer(
        verifierContainer,
        `mkdir -p ${LOGS_DIR}/verifier ${LOGS_DIR}/artifacts ${TESTS_DIR}`,
        { timeoutMs: 30_000 },
      );
      if (
        await stat(localArtifacts).then(
          () => true,
          () => false,
        )
      ) {
        await copyIntoContainer(verifierContainer, `${localArtifacts}/.`, `${LOGS_DIR}/artifacts`);
      }
      await copyIntoContainer(verifierContainer, `${join(task.dir, "tests")}/.`, TESTS_DIR);
      verifier = await execInContainer(verifierContainer, `bash ${TESTS_DIR}/test.sh`, {
        cwd: workdir,
        timeoutMs: task.verifierTimeoutSec * 1000,
        logPath: join(trialDir, "verifier.log"),
      });
      await copyFromContainer(
        verifierContainer,
        `${LOGS_DIR}/verifier`,
        join(trialDir, "verifier"),
      );
    } else {
      await copyIntoContainer(agentContainer, `${join(task.dir, "tests")}/.`, TESTS_DIR);
      verifier = await execInContainer(agentContainer, `bash ${TESTS_DIR}/test.sh`, {
        cwd: workdir,
        timeoutMs: task.verifierTimeoutSec * 1000,
        logPath: join(trialDir, "verifier.log"),
      });
      await copyFromContainer(agentContainer, `${LOGS_DIR}/verifier`, join(trialDir, "verifier"));
    }

    reward = await readReward(join(trialDir, "verifier"));
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    await removeContainer(agentContainer);
    await removeContainer(verifierContainer);
  }

  const telemetry = await readAgentTelemetry(join(trialDir, "agent"));
  if (telemetry.status === "timeout") {
    agent = { ...agent, status: "timeout" };
  }
  if (typeof telemetry.durationMs === "number" && telemetry.durationMs > 0) {
    agent = { ...agent, durationMs: telemetry.durationMs };
  }

  const result: TrialResult = {
    task: task.name,
    attempt,
    harness: bundle.harness,
    model,
    reward,
    agent,
    verifier,
    usage: telemetry.usage,
    overhead: telemetry.overhead,
    error,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
  await writeFile(join(trialDir, "trial.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
