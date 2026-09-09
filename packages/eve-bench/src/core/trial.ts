import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Writable } from "node:stream";

import { buildImage, Container, containerArch, pullImage, type ProcessResult } from "./docker.ts";
import type { Harness, HarnessBundle } from "./harness.ts";
import type { StepResult, TrialResult, Usage } from "./result.ts";
import type { Task } from "./task.ts";

export interface TrialInput {
  readonly task: Task;
  readonly attempt: number;
  readonly harness: Harness;
  readonly bundle: HarnessBundle;
  readonly model: string;
  /** Host env forwarded to the harness exec only (provider credentials). */
  readonly forwardEnv: Readonly<Record<string, string>>;
  readonly dir: string;
  readonly signal: AbortSignal;
}

const INSTALL_DIR = "/installed-agent";
const LOGS_DIR = "/logs";
const TESTS_DIR = "/tests";

export async function runTrial(input: TrialInput): Promise<TrialResult> {
  const { task, signal } = input;
  const startedAt = new Date().toISOString();
  await mkdir(input.dir, { recursive: true });
  const containerLog = createWriteStream(join(input.dir, "container.log"), { flags: "a" });
  let container: Container | undefined;
  let agent: StepResult = skipped();
  let verifier: StepResult = skipped();
  let reward: number | null = null;
  let usage: Usage | undefined;
  let error: string | undefined;
  try {
    const image = await resolveImage(task, containerLog, signal);
    container = await Container.start(
      {
        image,
        name: `eve-bench-${task.name}-${input.attempt}-${Date.now().toString(36)}`,
        cpus: task.environment.cpus,
        memoryMb: task.environment.memoryMb,
        network: task.environment.allowInternet,
      },
      signal,
    );
    const workdir = await resolveWorkdir(container);
    const bundleArch = input.bundle.arch;
    const arch = bundleArch ? await containerArch(container) : undefined;
    await container.exec(
      `mkdir -p ${INSTALL_DIR} ${LOGS_DIR}/agent ${LOGS_DIR}/verifier ${TESTS_DIR}${arch ? ` ${INSTALL_DIR}/arch` : ""}`,
      { timeoutMs: 30_000, signal },
    );
    await container.upload(`${input.bundle.dir}/.`, INSTALL_DIR, signal);
    if (arch && bundleArch) {
      await container.upload(`${bundleArch[arch]}/.`, `${INSTALL_DIR}/arch`, signal);
    }
    for (const path of input.harness.stage?.({ taskDir: task.dir }) ?? []) {
      await container.upload(path, INSTALL_DIR, signal);
    }
    const instructionPath = join(input.dir, "instruction.md");
    await writeFile(instructionPath, task.instruction);
    await container.upload(instructionPath, `${INSTALL_DIR}/instruction.md`, signal);

    const runContext = {
      model: input.model,
      installDir: INSTALL_DIR,
      instructionPath: `${INSTALL_DIR}/instruction.md`,
      taskWorkdir: workdir,
      logsDir: `${LOGS_DIR}/agent`,
    };
    agent = await step(() =>
      container!.exec(input.harness.command(runContext), {
        cwd: workdir,
        env: { ...input.forwardEnv, ...input.harness.env(runContext) },
        timeoutMs: task.agentTimeoutMs,
        signal,
        log: createWriteStream(join(input.dir, "agent.log")),
      }),
    );

    await container.upload(`${join(task.dir, "tests")}/.`, TESTS_DIR, signal);
    verifier = await step(() =>
      container!.exec(`bash ${TESTS_DIR}/test.sh`, {
        cwd: workdir,
        timeoutMs: task.verifierTimeoutMs,
        signal,
        log: createWriteStream(join(input.dir, "verifier.log")),
      }),
    );

    for (const logs of ["agent", "verifier"]) {
      if (!(await container.download(`${LOGS_DIR}/${logs}`, input.dir))) {
        containerLog.write(`[eve-bench] could not download ${LOGS_DIR}/${logs}\n`);
      }
    }
    reward = await readReward(join(input.dir, "verifier", "reward.txt"));
    usage = await readUsage(join(input.dir, "agent", "result.json"));
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    if (container) await container.remove();
    containerLog.end();
  }
  const result: TrialResult = {
    task: task.name,
    attempt: input.attempt,
    harness: input.harness.name,
    model: input.model,
    reward,
    agent,
    verifier,
    ...(usage ? { usage } : {}),
    ...(error ? { error } : {}),
    startedAt,
    finishedAt: new Date().toISOString(),
  };
  await writeFile(join(input.dir, "trial.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

async function resolveImage(task: Task, log: Writable, signal: AbortSignal): Promise<string> {
  const options = { timeoutMs: task.buildTimeoutMs, signal, log };
  if (task.environment.dockerImage) {
    await pullImage(task.environment.dockerImage, options);
    return task.environment.dockerImage;
  }
  const dockerfile = await readFile(join(task.environment.dockerfileDir, "Dockerfile"));
  const tag = `eve-bench/${task.name}:${createHash("sha256").update(dockerfile).digest("hex").slice(0, 12)}`;
  await buildImage(tag, task.environment.dockerfileDir, options);
  return tag;
}

async function resolveWorkdir(container: Container): Promise<string> {
  const result = await container.exec("pwd", { timeoutMs: 10_000 });
  const workdir = result.stdout.trim();
  if (result.exitCode !== 0 || workdir.length === 0) {
    throw new Error(`Could not resolve the task working directory: ${result.stderr.trim()}`);
  }
  return workdir;
}

async function step(run: () => Promise<ProcessResult>): Promise<StepResult> {
  const started = Date.now();
  const result = await run();
  return {
    status: result.timedOut
      ? "timeout"
      : result.aborted || result.exitCode !== 0
        ? "failed"
        : "completed",
    exitCode: result.exitCode,
    durationMs: Date.now() - started,
  };
}

function skipped(): StepResult {
  return { status: "skipped", exitCode: null, durationMs: 0 };
}

async function readReward(path: string): Promise<number | null> {
  try {
    const value = Number((await readFile(path, "utf8")).trim());
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

async function readUsage(path: string): Promise<Usage | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { usage?: Partial<Usage> };
    const usage = parsed.usage;
    if (!usage) return undefined;
    return {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      cachedTokens: usage.cachedTokens ?? 0,
      costUsd: usage.costUsd ?? 0,
    };
  } catch {
    return undefined;
  }
}
