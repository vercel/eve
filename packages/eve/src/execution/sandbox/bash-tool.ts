import type { SandboxSession } from "#shared/sandbox-session.js";
import { truncateTail } from "#execution/sandbox/truncate-output.js";
import { isEveDevEnvironment } from "#internal/application/optional-package-install.js";

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

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

/**
 * Structured result returned from {@link executeBashOnSandbox}.
 */
export interface BashResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
  /** True when stdout or stderr was shortened to fit within output limits. */
  readonly truncated: boolean;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * Executes one shell command inside the agent's sandbox via `SandboxKey`
 * on the active runtime context.
 *
 * Both stdout and stderr are tail-truncated to keep the end of the output
 * (where errors and final results typically appear) within the shared
 * {@link MAX_OUTPUT_LINES} / {@link MAX_OUTPUT_BYTES} limits.
 *
 * Used by the framework `bash` tool and by author tools constructed via
 * `defineBashTool`. Centralizing the executor here keeps the error
 * messages and result shape identical across all bash-style tools.
 */
export async function executeBashOnSandbox(
  sandbox: SandboxSession,
  args: BashInput,
): Promise<BashResult> {
  const raw = await runWithDevelopmentSandboxProgress(sandbox, args.command);

  const stdoutResult = truncateTail(raw.stdout);
  const stderrResult = truncateTail(raw.stderr);
  const truncated = stdoutResult.truncated || stderrResult.truncated;

  let stdout = stdoutResult.output;
  if (stdoutResult.truncated) {
    stdout =
      `[stdout truncated: showing last ${stdoutResult.outputLines} of ${stdoutResult.totalLines} lines]\n` +
      stdout;
  }

  let stderr = stderrResult.output;
  if (stderrResult.truncated) {
    stderr =
      `[stderr truncated: showing last ${stderrResult.outputLines} of ${stderrResult.totalLines} lines]\n` +
      stderr;
  }

  return {
    exitCode: raw.exitCode,
    stderr,
    stdout,
    truncated,
  };
}

async function runWithDevelopmentSandboxProgress(
  sandbox: SandboxSession,
  command: string,
): Promise<Awaited<ReturnType<SandboxSession["run"]>>> {
  logDevelopmentSandboxCommand(`eve: starting sandbox command: ${formatCommand(command)}`);
  if (!isEveDevEnvironment()) {
    return await sandbox.run({ command });
  }

  const startedAt = Date.now();
  const timer = setInterval(() => {
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    logDevelopmentSandboxCommand(
      `eve: waiting for sandbox command (${elapsedSeconds}s elapsed): ${formatCommand(command)}`,
    );
  }, 5_000);
  timer.unref?.();

  try {
    const result = await sandbox.run({ command });
    logDevelopmentSandboxCommand(
      `eve: sandbox command finished (exit ${result.exitCode}): ${formatCommand(command)}`,
    );
    return result;
  } catch (error) {
    logDevelopmentSandboxCommand(`eve: sandbox command failed: ${formatCommand(command)}`);
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
