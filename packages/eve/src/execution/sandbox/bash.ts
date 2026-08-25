import type { SandboxSession } from "#shared/sandbox-session.js";
import {
  startBackgroundBashProcess,
  waitForBackgroundBashProcess,
} from "#execution/sandbox/bash-background.js";
import { truncateTail } from "#execution/sandbox/truncate-output.js";

export interface BashInput {
  readonly command: string;
  readonly yieldAfter?: number;
}

export interface BashExecuteOptions {
  readonly abortSignal?: AbortSignal;
}

export const DEFAULT_BASH_YIELD_AFTER_SECONDS = 300;

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
}

/** Starts one shell command and yields it to the background after the foreground wait. */
export async function executeBashOnSandbox(
  sandbox: SandboxSession,
  args: BashInput,
  options?: BashExecuteOptions,
): Promise<BashResult> {
  const process = await startBackgroundBashProcess(sandbox, args.command);
  let state;
  try {
    state = await waitForBackgroundBashProcess({
      abortSignal: options?.abortSignal,
      process,
      yieldAfterMs: (args.yieldAfter ?? DEFAULT_BASH_YIELD_AFTER_SECONDS) * 1_000,
    });
  } catch (error) {
    try {
      await process.kill();
    } catch (killError) {
      throw new AggregateError(
        [error, killError],
        "The bash command was cancelled but could not be killed.",
        {
          cause: error,
        },
      );
    }
    throw error;
  }

  const observed = state ?? (await process.read());
  const output = formatBashOutput(observed.stdout, observed.stderr);
  return state === null
    ? { ...output, processId: process.processId, status: "running" }
    : { ...output, exitCode: state.exitCode!, status: "completed" };
}

export function formatBashOutput(stdoutValue: string, stderrValue: string): BashOutput {
  const stdoutResult = truncateTail(stdoutValue);
  const stderrResult = truncateTail(stderrValue);
  let stdout = stdoutResult.output;
  let stderr = stderrResult.output;
  if (stdoutResult.truncated) {
    stdout =
      `[stdout truncated: showing last ${stdoutResult.outputLines} of ${stdoutResult.totalLines} lines]\n` +
      stdout;
  }
  if (stderrResult.truncated) {
    stderr =
      `[stderr truncated: showing last ${stderrResult.outputLines} of ${stderrResult.totalLines} lines]\n` +
      stderr;
  }
  return {
    stderr,
    stdout,
    truncated: stdoutResult.truncated || stderrResult.truncated,
  };
}
