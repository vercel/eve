import type { SandboxSession } from "#shared/sandbox-session.js";
import {
  startBackgroundBashProcess,
  waitForBackgroundBashProcess,
} from "#execution/sandbox/bash-background.js";
import { truncateHeadTail } from "#execution/sandbox/truncate-output.js";

export interface BashInput {
  readonly command: string;
  readonly yieldTimeMs?: number;
}

export interface BashExecuteOptions {
  readonly abortSignal?: AbortSignal;
}

export const DEFAULT_BASH_YIELD_TIME_MS = 300_000;

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

/** Starts one shell command and yields it to the background after the foreground wait. */
export async function executeBashOnSandbox(
  sandbox: SandboxSession,
  args: BashInput,
  options?: BashExecuteOptions,
): Promise<BashResult> {
  const startedAt = Date.now();
  const process = await startBackgroundBashProcess(sandbox, args.command);
  let state;
  try {
    state = await waitForBackgroundBashProcess({
      abortSignal: options?.abortSignal,
      process,
      yieldTimeMs: args.yieldTimeMs ?? DEFAULT_BASH_YIELD_TIME_MS,
    });
  } catch (error) {
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

  const observed = state ?? (await process.read());
  const output = formatBashOutput(observed.stdout, observed.stderr, startedAt);
  return state === null
    ? { ...output, processId: process.processId, status: "running" }
    : { ...output, exitCode: state.exitCode!, status: "completed" };
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
