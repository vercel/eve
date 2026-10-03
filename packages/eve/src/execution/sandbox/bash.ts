import type { SandboxCommandResult, SandboxSession } from "#shared/sandbox-session.js";
import {
  BASH_JOB_MAX_WAIT_SECONDS,
  BASH_JOB_ROOT,
  BASH_JOB_YIELD_SECONDS,
  createBashJobId,
  createBashJobLaunch,
  type BashJobLaunchOutput,
} from "#execution/sandbox/bash-jobs.js";
import { truncateTail } from "#execution/sandbox/truncate-output.js";
import { isEveDevEnvironment } from "#internal/application/dev-environment.js";

const MAX_LOG_COMMAND_LENGTH = 240;

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

/**
 * Typed input accepted by {@link executeBashOnSandbox}.
 */
export interface BashInput {
  readonly command: string;
}

/**
 * Per-call options for {@link executeBashOnSandbox}.
 */
export interface BashExecutionOptions {
  /**
   * Identifies this tool call within the sandbox, such as the session id and
   * call id. A command that outlives the yield becomes a job named after it,
   * so a retried call reattaches to a job its earlier attempt already
   * reported instead of starting the command again. Calls without a key get
   * a random job id.
   */
  readonly jobKey?: string;
}

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

interface BashStreams {
  readonly stderr: string;
  readonly stdout: string;
  /** True when stdout or stderr was shortened to fit within output limits. */
  readonly truncated: boolean;
}

/**
 * Structured result returned from {@link executeBashOnSandbox}: the command
 * finished, or it is still running as a job the model can observe or stop
 * with `eve-job` through later commands.
 */
type BashResult =
  | (BashStreams & { readonly status: "completed"; readonly exitCode: number })
  | (BashStreams & {
      readonly status: "running";
      readonly jobId: string;
      readonly message: string;
    });

interface RawStreams {
  readonly stderr: string;
  readonly stdout: string;
}

/** Bytes the sandbox dropped from the start of each stream before sending it. */
interface SkippedBytes {
  readonly stderr: number;
  readonly stdout: number;
}

const NOTHING_SKIPPED: SkippedBytes = { stderr: 0, stdout: 0 };

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * Executes one shell command inside the agent's sandbox.
 *
 * In sandboxes with a real process model, the command runs as a background
 * job. If it finishes within {@link BASH_JOB_YIELD_SECONDS}, the result is
 * the finished command. Otherwise the call returns the output so far with
 * `status: "running"`, and the job keeps running inside the sandbox, where
 * later `eve-job wait` and `eve-job stop` commands observe or stop it. Job
 * state lives in sandbox files, so any later step can reach it. Sandboxes
 * without a real process model, such as `just-bash`, run the command
 * directly and always return the finished command.
 *
 * Both stdout and stderr are tail-truncated to keep the end of the output
 * (where errors and final results typically appear) within the shared
 * output limits.
 */
export async function executeBashOnSandbox(
  sandbox: SandboxSession,
  args: BashInput,
  options: BashExecutionOptions = {},
): Promise<BashResult> {
  const launch = createBashJobLaunch({
    command: args.command,
    jobId: createBashJobId(options.jobKey),
    root: BASH_JOB_ROOT,
    yieldSeconds: BASH_JOB_YIELD_SECONDS,
  });
  const command = formatCommand(args.command);
  logDevelopmentSandboxCommand(`eve: starting sandbox command: ${command}`);
  const result = await withDevelopmentSandboxProgress(command, async () => {
    const raw = await sandbox.run({ command: launch.command });
    return await toBashResult(sandbox, args.command, launch.parse(raw), raw);
  });
  logDevelopmentSandboxCommand(
    result.status === "running"
      ? `eve: sandbox command still running as ${result.jobId}: ${command}`
      : `eve: sandbox command finished (exit ${result.exitCode}): ${command}`,
  );
  return result;
}

async function toBashResult(
  sandbox: SandboxSession,
  command: string,
  launched: BashJobLaunchOutput | undefined,
  raw: SandboxCommandResult,
): Promise<BashResult> {
  if (launched === undefined) {
    // The launcher failed before it reported a job; its own output says why.
    return completed(raw.exitCode, raw, NOTHING_SKIPPED);
  }
  if (launched.kind === "unsupported") {
    const direct = await sandbox.run({ command });
    return completed(direct.exitCode, direct, NOTHING_SKIPPED);
  }
  const skipped = { stderr: launched.stderrSkippedBytes, stdout: launched.stdoutSkippedBytes };
  if (launched.state === "running") {
    const { jobId } = launched;
    return {
      ...formatStreams(launched, skipped),
      jobId,
      message:
        `The command is still running after ${BASH_JOB_YIELD_SECONDS} seconds as job ${jobId}. stdout and stderr show its output so far. ` +
        `To see new output, run \`eve-job wait ${jobId}\` with this tool; add a number of seconds to wait longer, up to ${BASH_JOB_MAX_WAIT_SECONDS}. ` +
        `To stop it, run \`eve-job stop ${jobId}\`.`,
      status: "running",
    };
  }
  if (launched.state === "lost") {
    const stderr = `${launched.stderr}[the command's process ended without recording an exit code]\n`;
    return completed(-1, { stderr, stdout: launched.stdout }, skipped);
  }
  return completed(launched.exitCode ?? -1, launched, skipped);
}

function completed(exitCode: number, streams: RawStreams, skipped: SkippedBytes): BashResult {
  return { ...formatStreams(streams, skipped), exitCode, status: "completed" };
}

function formatStreams(streams: RawStreams, skipped: SkippedBytes): BashStreams {
  const stdout = formatStream("stdout", streams.stdout, skipped.stdout);
  const stderr = formatStream("stderr", streams.stderr, skipped.stderr);
  return {
    stderr: stderr.output,
    stdout: stdout.output,
    truncated: stdout.truncated || stderr.truncated,
  };
}

function formatStream(
  name: "stderr" | "stdout",
  text: string,
  skippedBytes: number,
): { readonly output: string; readonly truncated: boolean } {
  const result = truncateTail(text);
  if (!result.truncated && skippedBytes === 0) {
    return { output: result.output, truncated: false };
  }
  const note =
    skippedBytes === 0
      ? `[${name} truncated: showing last ${result.outputLines} of ${result.totalLines} lines]`
      : `[${name} truncated: showing last ${result.outputLines} lines; earlier output omitted]`;
  return { output: `${note}\n${result.output}`, truncated: true };
}

async function withDevelopmentSandboxProgress<T>(
  command: string,
  run: () => Promise<T>,
): Promise<T> {
  if (!isEveDevEnvironment()) {
    return await run();
  }

  const startedAt = Date.now();
  const timer = setInterval(() => {
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    logDevelopmentSandboxCommand(
      `eve: waiting for sandbox command (${elapsedSeconds}s elapsed): ${command}`,
    );
  }, 5_000);
  timer.unref?.();

  try {
    return await run();
  } catch (error) {
    logDevelopmentSandboxCommand(`eve: sandbox command failed: ${command}`);
    throw error;
  } finally {
    clearInterval(timer);
  }
}

function logDevelopmentSandboxCommand(message: string): void {
  if (isEveDevEnvironment()) {
    console.log(message);
  }
}

function formatCommand(command: string): string {
  const singleLine = command.replaceAll(/\s+/g, " ").trim();
  if (singleLine.length <= MAX_LOG_COMMAND_LENGTH) {
    return singleLine;
  }
  return `${singleLine.slice(0, MAX_LOG_COMMAND_LENGTH - 1)}…`;
}
