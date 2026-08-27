import { randomUUID } from "node:crypto";

import type { SandboxSession } from "#shared/sandbox-session.js";
import {
  canReconnectManagedSandboxCommands,
  getManagedSandboxCommands,
  MAX_MANAGED_SANDBOX_COMMANDS,
  type ManagedSandboxCommand,
} from "#execution/sandbox/managed-command.js";
import { truncateTail } from "#execution/sandbox/truncate-output.js";
import { getInvocationDeadline } from "#internal/invocation/deadline.js";
import { isEveDevEnvironment } from "#internal/application/optional-package-install.js";

const MAX_LOG_COMMAND_LENGTH = 240;
const POLL_INTERVAL_MS = 250;

export const DEFAULT_BASH_RUN_YIELD_TIME_MS = 30_000;
export const DEFAULT_BASH_WAIT_YIELD_TIME_MS = 30_000;
export const MAX_BASH_INLINE_WAIT_MS = 30_000;
export const BASH_SETTLEMENT_HEADROOM_MS = 5_000;
export const MAX_BACKGROUND_BASH_PROCESSES = MAX_MANAGED_SANDBOX_COMMANDS;

export interface BashInput {
  readonly command: string;
  readonly yieldTimeMs?: number;
}

export interface BashExecuteOptions {
  readonly abortSignal?: AbortSignal;
  readonly idempotencyKey?: string;
  readonly onStarted?: (process: ManagedSandboxCommand) => Promise<void>;
}

export type BashResult = BashOutput &
  (
    | { readonly exitCode: number; readonly status: "completed" }
    | { readonly processId: string; readonly status: "running" }
  );

export interface BashOutput {
  readonly stderr: string;
  readonly stdout: string;
  readonly truncated: boolean;
  /** Elapsed wall time this call spent before returning, in seconds. */
  readonly wallTimeSeconds: number;
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
    if (options?.onStarted !== undefined) {
      try {
        await options.onStarted(process);
      } catch (error) {
        await process.terminate().catch(() => {});
        throw error;
      }
    }
    try {
      const yieldTimeMs = resolveBashInlineWaitMs(
        args.yieldTimeMs ?? DEFAULT_BASH_RUN_YIELD_TIME_MS,
      );
      if (yieldTimeMs === 0) {
        options?.abortSignal?.throwIfAborted();
      } else {
        await waitForBackgroundBashProcess({
          abortSignal: options?.abortSignal,
          process,
          yieldTimeMs,
        });
      }
    } catch (error) {
      if (!options?.abortSignal?.aborted) throw error;
      try {
        await process.terminate();
      } catch (killError) {
        throw new AggregateError(
          [error, killError],
          "The bash command was cancelled but could not be killed.",
          { cause: error },
        );
      }
      throw error;
    }

    const observed = await process.inspect();
    const output = formatBashOutput(
      observed.stdout,
      observed.stderr,
      startedAt,
      observed.truncated,
    );
    const result: BashResult =
      observed.exitCode === undefined
        ? { ...output, processId: process.commandId, status: "running" }
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

export function supportsDurableBashCompletion(sandbox: SandboxSession): boolean {
  return canReconnectManagedSandboxCommands(sandbox);
}

/** Bounds one inline wait by the requested interval and Function lifetime. */
export function resolveBashInlineWaitMs(
  requestedMs: number,
  input: {
    readonly deadline?: Date;
    readonly nowMs?: number;
    readonly settlementHeadroomMs?: number;
  } = {},
): number {
  const requested = Math.min(Math.max(0, requestedMs), MAX_BASH_INLINE_WAIT_MS);
  const deadline = input.deadline ?? getInvocationDeadline();
  if (deadline === undefined) return requested;

  const remaining =
    deadline.getTime() -
    (input.nowMs ?? Date.now()) -
    (input.settlementHeadroomMs ?? BASH_SETTLEMENT_HEADROOM_MS);
  return Math.min(requested, Math.max(0, remaining));
}

export async function startBackgroundBashProcess(
  sandbox: SandboxSession,
  command: string,
  idempotencyKey: string = randomUUID(),
): Promise<ManagedSandboxCommand> {
  return await getManagedSandboxCommands(sandbox).start({ command, idempotencyKey });
}

export async function getBackgroundBashProcess(
  sandbox: SandboxSession,
  processId: string,
): Promise<ManagedSandboxCommand> {
  return await getManagedSandboxCommands(sandbox).get(processId);
}

export async function waitForBackgroundBashProcess(input: {
  readonly abortSignal?: AbortSignal;
  readonly process: ManagedSandboxCommand;
  readonly yieldTimeMs: number;
}): Promise<{ readonly exitCode?: number } | null> {
  const deadline = Date.now() + input.yieldTimeMs;
  while (true) {
    input.abortSignal?.throwIfAborted();
    const state = await input.process.inspectStatus();
    if (state.exitCode !== undefined) return state;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    await abortableDelay(Math.min(POLL_INTERVAL_MS, remaining), input.abortSignal);
  }
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
