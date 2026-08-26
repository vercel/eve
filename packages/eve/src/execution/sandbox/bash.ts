import { randomUUID } from "node:crypto";

import type { SandboxSession } from "#shared/sandbox-session.js";
import { shellQuote } from "#execution/sandbox/shell-quote.js";
import { truncateHeadTail } from "#execution/sandbox/truncate-output.js";

const PROCESS_ROOT = "/workspace/.eve/processes";
const POLL_INTERVAL_MS = 250;
const PROCESS_LIMIT_MARKER = "EVE_BASH_PROCESS_LIMIT";

export const DEFAULT_BASH_YIELD_TIME_MS = 300_000;
export const MAX_BACKGROUND_BASH_PROCESSES = 64;

export interface BashInput {
  readonly command: string;
  readonly yieldTimeMs?: number;
}

export interface BashExecuteOptions {
  readonly abortSignal?: AbortSignal;
}

export type BashResult = BashCompletedResult | BashRunningResult;

export interface BashCompletedResult extends BashOutput {
  readonly exitCode: number;
  readonly status: "completed";
}

export interface BashRunningResult extends BashOutput {
  readonly processId: string;
  readonly status: "running";
}

export interface BashOutput {
  readonly stderr: string;
  readonly stdout: string;
  readonly truncated: boolean;
  /** Elapsed wall time this call spent before returning, in seconds. */
  readonly wallTimeSeconds: number;
}

export interface BackgroundBashProcess {
  readonly processId: string;
  read(): Promise<BackgroundBashProcessState>;
  readStatus(): Promise<BackgroundBashProcessStatus>;
  kill(): Promise<void>;
}

export interface BackgroundBashProcessStatus {
  readonly exitCode?: number;
}

export interface BackgroundBashProcessState extends BackgroundBashProcessStatus {
  readonly stderr: string;
  readonly stdout: string;
}

/** Starts one shell command and yields it to the background after the foreground wait. */
export async function executeBashOnSandbox(
  sandbox: SandboxSession,
  args: BashInput,
  options?: BashExecuteOptions,
): Promise<BashResult> {
  const startedAt = Date.now();
  const process = await startBackgroundBashProcess(sandbox, args.command);
  try {
    await waitForBackgroundBashProcess({
      abortSignal: options?.abortSignal,
      process,
      yieldTimeMs: args.yieldTimeMs ?? DEFAULT_BASH_YIELD_TIME_MS,
    });
  } catch (error) {
    if (!options?.abortSignal?.aborted) {
      throw error;
    }
    try {
      await process.kill();
    } catch (killError) {
      throw new AggregateError(
        [error, killError],
        "The bash command was cancelled but could not be killed.",
        { cause: error },
      );
    }
    throw error;
  }

  const observed = await process.read();
  const output = formatBashOutput(observed.stdout, observed.stderr, startedAt);
  return observed.exitCode === undefined
    ? { ...output, processId: process.processId, status: "running" }
    : { ...output, exitCode: observed.exitCode, status: "completed" };
}

export async function startBackgroundBashProcess(
  sandbox: SandboxSession,
  command: string,
): Promise<BackgroundBashProcess> {
  const processId = randomUUID();
  const directory = `${PROCESS_ROOT}/${processId}`;
  const quotedRoot = shellQuote(PROCESS_ROOT);
  const launch = [
    `mkdir -p ${quotedRoot}`,
    `if [ "$(ls ${quotedRoot} | wc -l)" -ge ${MAX_BACKGROUND_BASH_PROCESSES} ]; then for d in ${quotedRoot}/*/; do [ -f "$d/exit-code" ] && rm -rf "$d"; done; fi`,
    `if [ "$(ls ${quotedRoot} | wc -l)" -ge ${MAX_BACKGROUND_BASH_PROCESSES} ]; then echo ${PROCESS_LIMIT_MARKER} >&2; exit 75; fi`,
    `mkdir -p ${shellQuote(directory)}`,
    `set -m 2>/dev/null || true`,
    `( ( eval ${shellQuote(command)} ); code=$?; printf '%s' "$code" > ${shellQuote(`${directory}/exit-code.tmp`)} && mv ${shellQuote(`${directory}/exit-code.tmp`)} ${shellQuote(`${directory}/exit-code`)} ) > ${shellQuote(`${directory}/stdout`)} 2> ${shellQuote(`${directory}/stderr`)} &`,
    `printf '%s' "$!" > ${shellQuote(`${directory}/pid`)}`,
  ].join("\n");
  const result = await sandbox.run({ command: launch });
  if (result.exitCode !== 0) {
    if (result.stderr.includes(PROCESS_LIMIT_MARKER)) {
      throw new Error(
        `This sandbox already tracks ${MAX_BACKGROUND_BASH_PROCESSES} running background commands. Kill or wait for existing processes before starting another.`,
      );
    }
    throw new Error(`Failed to start background command: ${result.stderr || result.stdout}`);
  }

  return backgroundBashProcess(sandbox, processId);
}

export function getBackgroundBashProcess(
  sandbox: SandboxSession,
  processId: string,
): BackgroundBashProcess {
  if (!/^[0-9a-f-]{36}$/.test(processId)) {
    throw new Error("Invalid bash process id.");
  }
  return backgroundBashProcess(sandbox, processId);
}

export async function waitForBackgroundBashProcess(input: {
  readonly abortSignal?: AbortSignal;
  readonly process: BackgroundBashProcess;
  readonly yieldTimeMs: number;
}): Promise<BackgroundBashProcessStatus | null> {
  const deadline = Date.now() + input.yieldTimeMs;
  while (true) {
    input.abortSignal?.throwIfAborted();
    const state = await input.process.readStatus();
    if (state.exitCode !== undefined) return state;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    await abortableDelay(Math.min(POLL_INTERVAL_MS, remaining), input.abortSignal);
  }
}

function backgroundBashProcess(sandbox: SandboxSession, processId: string): BackgroundBashProcess {
  const directory = `${PROCESS_ROOT}/${processId}`;
  return {
    processId,
    async read() {
      const [status, stdout, stderr] = await Promise.all([
        readBackgroundBashProcessStatus(sandbox, processId, directory),
        sandbox.readTextFile({ path: `${directory}/stdout` }),
        sandbox.readTextFile({ path: `${directory}/stderr` }),
      ]);
      return { ...status, stderr: stderr ?? "", stdout: stdout ?? "" };
    },
    async readStatus() {
      return await readBackgroundBashProcessStatus(sandbox, processId, directory);
    },
    async kill() {
      const pidValue = await sandbox.readTextFile({ path: `${directory}/pid` });
      const pid = pidValue?.trim();
      if (!pid || !/^[1-9]\d*$/.test(pid)) {
        throw new Error(`Bash process "${processId}" could not be killed by this sandbox backend.`);
      }

      if (await isProcessAlive(sandbox, pid)) {
        await signalProcess(sandbox, pid);
        await abortableDelay(100);
        if (await isProcessAlive(sandbox, pid)) {
          await signalProcess(sandbox, pid, "-KILL");
        }
      }
      await sandbox.removePath({ force: true, path: directory, recursive: true });
    },
  };
}

async function isProcessAlive(sandbox: SandboxSession, pid: string): Promise<boolean> {
  const result = await sandbox.run({
    command: `kill -0 -- -${pid} 2>/dev/null || kill -0 ${pid} 2>/dev/null`,
  });
  return result.exitCode === 0;
}

async function signalProcess(
  sandbox: SandboxSession,
  pid: string,
  signal?: "-KILL",
): Promise<void> {
  const option = signal ? `${signal} ` : "";
  const result = await sandbox.run({
    command: `kill ${option}-- -${pid} 2>/dev/null || kill ${option}${pid} 2>/dev/null`,
  });
  if (result.exitCode !== 0 && (await isProcessAlive(sandbox, pid))) {
    throw new Error(`Bash process ${pid} could not be signalled by this sandbox backend.`);
  }
}

async function readBackgroundBashProcessStatus(
  sandbox: SandboxSession,
  processId: string,
  directory: string,
): Promise<BackgroundBashProcessStatus> {
  const [pid, exitCode] = await Promise.all([
    sandbox.readTextFile({ path: `${directory}/pid` }),
    sandbox.readTextFile({ path: `${directory}/exit-code` }),
  ]);
  if (pid === null) {
    throw new Error(`Bash process "${processId}" does not exist.`);
  }
  return exitCode === null ? {} : { exitCode: Number.parseInt(exitCode, 10) };
}

function abortableDelay(ms: number, abortSignal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortSignal?.reason);
    };
    const timer = setTimeout(() => {
      abortSignal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function formatBashOutput(
  stdoutValue: string,
  stderrValue: string,
  startedAt: number,
): BashOutput {
  const stdoutResult = truncateHeadTail(stdoutValue);
  const stderrResult = truncateHeadTail(stderrValue);
  return {
    stderr: stderrResult.output,
    stdout: stdoutResult.output,
    truncated: stdoutResult.truncated || stderrResult.truncated,
    wallTimeSeconds: wallTimeSeconds(startedAt),
  };
}

export function wallTimeSeconds(startedAt: number): number {
  return Math.round(Date.now() - startedAt) / 1_000;
}
