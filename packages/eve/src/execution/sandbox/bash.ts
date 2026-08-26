import { randomUUID } from "node:crypto";

import type { SandboxSession } from "#shared/sandbox-session.js";
import {
  getManagedSandboxCommands,
  MAX_MANAGED_SANDBOX_COMMANDS,
  type ManagedSandboxCommand,
  type ManagedSandboxCommandObservation,
} from "#execution/sandbox/managed-command.js";
import { truncateTail } from "#execution/sandbox/truncate-output.js";
import { isEveDevEnvironment } from "#internal/application/optional-package-install.js";

const MAX_LOG_COMMAND_LENGTH = 240;
const POLL_INTERVAL_MS = 250;

export const DEFAULT_BASH_YIELD_TIME_MS = 300_000;
export const MAX_BACKGROUND_BASH_PROCESSES = MAX_MANAGED_SANDBOX_COMMANDS;

export interface BashInput {
  readonly command: string;
  readonly yieldTimeMs?: number;
}

export interface BashExecuteOptions {
  readonly abortSignal?: AbortSignal;
  readonly idempotencyKey?: string;
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
  readonly truncated?: boolean;
}

/**
 * Executes one shell command inside the agent's sandbox.
 *
 * The command waits in the foreground for a bounded interval, then continues
 * in the background when still running. Both stdout and stderr are
 * tail-truncated because errors and final results typically appear at the end.
 *
 * Used by the framework `bash` tool and authored wrappers around its exported
 * definition so all bash-style tools share one result shape and lifecycle.
 */
export async function executeBashOnSandbox(
  sandbox: SandboxSession,
  args: BashInput,
  options?: BashExecuteOptions,
): Promise<BashResult> {
  const startedAt = Date.now();
  const commandLabel = formatCommand(args.command);
  logDevelopmentSandboxCommand(`eve: starting sandbox command: ${commandLabel}`);
  const progressTimer = startDevelopmentProgressTimer(commandLabel, startedAt);

  try {
    const process = await startBackgroundBashProcess(
      sandbox,
      args.command,
      options?.idempotencyKey ?? randomUUID(),
    );
    try {
      await waitForBackgroundBashProcess({
        abortSignal: options?.abortSignal,
        process,
        yieldTimeMs: args.yieldTimeMs ?? DEFAULT_BASH_YIELD_TIME_MS,
      });
    } catch (error) {
      if (!options?.abortSignal?.aborted) throw error;
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
    const output = formatBashOutput(
      observed.stdout,
      observed.stderr,
      startedAt,
      observed.truncated,
    );
    const result: BashResult =
      observed.exitCode === undefined
        ? { ...output, processId: process.processId, status: "running" }
        : { ...output, exitCode: observed.exitCode, status: "completed" };
    logDevelopmentSandboxCommand(
      result.status === "completed"
        ? `eve: sandbox command finished (exit ${result.exitCode}): ${commandLabel}`
        : `eve: sandbox command yielded: ${commandLabel}`,
    );
    return result;
  } catch (error) {
    logDevelopmentSandboxCommand(`eve: sandbox command failed: ${commandLabel}`);
    throw error;
  } finally {
    if (progressTimer !== undefined) clearInterval(progressTimer);
  }
}

export async function startBackgroundBashProcess(
  sandbox: SandboxSession,
  command: string,
  idempotencyKey: string = randomUUID(),
): Promise<BackgroundBashProcess> {
  return adaptManagedCommand(
    await getManagedSandboxCommands(sandbox).start({ command, idempotencyKey }),
  );
}

export async function getBackgroundBashProcess(
  sandbox: SandboxSession,
  processId: string,
): Promise<BackgroundBashProcess> {
  return adaptManagedCommand(await getManagedSandboxCommands(sandbox).get(processId));
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

function adaptManagedCommand(command: ManagedSandboxCommand): BackgroundBashProcess {
  return {
    processId: command.commandId,
    async read() {
      return toBackgroundState(await command.inspect());
    },
    async readStatus() {
      return await command.inspectStatus();
    },
    async kill() {
      await command.terminate();
    },
  };
}

function toBackgroundState(
  observation: ManagedSandboxCommandObservation,
): BackgroundBashProcessState {
  return observation;
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
  alreadyTruncated = false,
): BashOutput {
  const stdoutResult = truncateTail(stdoutValue);
  const stderrResult = truncateTail(stderrValue);
  return {
    stderr: stderrResult.output,
    stdout: stdoutResult.output,
    truncated: alreadyTruncated || stdoutResult.truncated || stderrResult.truncated,
    wallTimeSeconds: wallTimeSeconds(startedAt),
  };
}

export function wallTimeSeconds(startedAt: number): number {
  return Math.round(Date.now() - startedAt) / 1_000;
}

function startDevelopmentProgressTimer(
  command: string,
  startedAt: number,
): NodeJS.Timeout | undefined {
  if (!isEveDevEnvironment()) return undefined;
  const timer = setInterval(() => {
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1_000);
    logDevelopmentSandboxCommand(
      `eve: waiting for sandbox command (${elapsedSeconds}s elapsed): ${command}`,
    );
  }, 5_000);
  timer.unref?.();
  return timer;
}

function logDevelopmentSandboxCommand(message: string): void {
  if (isEveDevEnvironment()) console.log(message);
}

function formatCommand(command: string): string {
  const singleLine = command.replaceAll(/\s+/g, " ").trim();
  if (singleLine.length <= MAX_LOG_COMMAND_LENGTH) return singleLine;
  return `${singleLine.slice(0, MAX_LOG_COMMAND_LENGTH - 1)}…`;
}
