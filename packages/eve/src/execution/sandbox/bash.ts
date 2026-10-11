import { randomUUID } from "node:crypto";

import type { SandboxSession } from "#shared/sandbox-session.js";
import { shellQuote } from "#execution/sandbox/shell-quote.js";
import { streamToBuffer } from "#execution/sandbox/stream-utils.js";
import { MAX_OUTPUT_BYTES, truncateTail } from "#execution/sandbox/truncate-output.js";
import { isEveDevEnvironment } from "#internal/application/dev-environment.js";

/** How long a `bash` call waits before it leaves the command running in the background. */
export const BASH_YIELD_SECONDS = 30;

/** Where each command's output files live inside the sandbox. */
const JOB_ROOT = "/tmp/.eve/jobs";

const MAX_LOG_COMMAND_LENGTH = 240;

// The launcher runs the command in its own process group with its output in
// files, so the command can outlive this call. If the command finishes first,
// the launcher prints its output and exits with its code. Whichever of the
// launcher and the yield's claim creates `claimed` first reports the command;
// a claim also signals the launcher to exit, which ends the provider's stream
// without touching the command. The command holds none of the launcher's file
// descriptors, or the stream would stay open until the command exits.
const LAUNCHER = `d=$1
mkdir -p "$d" 2>/dev/null || { eval "$2"; exit; }
trap 'exit 0' USR1
echo "$$" > "$d/launcher"
set -m
(
  trap : TERM INT
  (eval "$2") > "$d/stdout" 2> "$d/stderr"
  code=$?
  echo "$code" > "$d/exit"
  exit "$code"
) < /dev/null > /dev/null 2>&1 &
pid=$!
set +m
echo "$pid" > "$d/pid"
wait "$pid" 2> /dev/null
code=$?
mkdir "$d/claimed" 2> /dev/null || exit 0
cat "$d/stdout"
cat "$d/stderr" >&2
rm -rf "$d"
exit "$code"`;

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
   * Stops the command when aborted before the call returns. A command
   * already returned as `running` keeps running.
   */
  readonly abortSignal?: AbortSignal;
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
 * finished, or it is still running in the background.
 */
type BashResult =
  | (BashStreams & { readonly status: "completed"; readonly exitCode: number })
  | (BashStreams & {
      readonly status: "running";
      readonly pid: number;
      readonly outputDirectory: string;
      readonly message: string;
    });

interface RawStreams {
  readonly stderr: string;
  readonly stdout: string;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * Executes one shell command inside the agent's sandbox.
 *
 * A command that finishes within {@link BASH_YIELD_SECONDS} returns its exit
 * code and output. A slower command keeps running in the sandbox as its own
 * process group, writing to files the model reads with later commands, and
 * the call returns its output so far with `status: "running"`. Sandboxes that
 * cannot run background processes, such as `just-bash`, run every command to
 * completion.
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
  const command = formatCommand(args.command);
  logDevelopmentSandboxCommand(`eve: starting sandbox command: ${command}`);
  const result = await withDevelopmentSandboxProgress(command, () =>
    runCommand(sandbox, args.command, options.abortSignal),
  );
  logDevelopmentSandboxCommand(
    result.status === "running"
      ? `eve: sandbox command still running as pid ${result.pid}: ${command}`
      : `eve: sandbox command finished (exit ${result.exitCode}): ${command}`,
  );
  return result;
}

async function runCommand(
  sandbox: SandboxSession,
  command: string,
  signal: AbortSignal | undefined,
): Promise<BashResult> {
  signal?.throwIfAborted();
  const jobId = randomUUID().slice(0, 8);
  const directory = `${JOB_ROOT}/${jobId}`;
  // The call's signal also aborts after the call returns, so it is linked
  // only while the call runs; a returned `running` command must survive it.
  const controller = new AbortController();
  const cancel = () => {
    controller.abort(signal?.reason);
    // Providers may stop only the launcher, and the command runs in its own process group.
    void Promise.resolve(
      sandbox.run({
        command: `kill -TERM -- -"$(cat ${shellQuote(directory)}/pid 2>/dev/null)" 2>/dev/null; rm -rf ${shellQuote(directory)}`,
      }),
    ).catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const child = await sandbox.spawn({
      abortSignal: controller.signal,
      command: launchCommand(command, directory),
    });
    const finished = Promise.all([
      readText(child.stdout),
      readText(child.stderr),
      child.wait(),
    ]).then(([stdout, stderr, { exitCode }]) => ({ exitCode, stderr, stdout }));
    const done = await waitUpTo(finished, BASH_YIELD_SECONDS * 1000);
    if (done !== undefined) return completed(done.exitCode, done);
    const running = await claimRunningJob(sandbox, directory, jobId);
    if (running === undefined) {
      // No job to claim: the sandbox cannot run background processes, or
      // the command finished as the yield began.
      const result = await finished;
      return completed(result.exitCode, result);
    }
    void finished.catch(() => {});
    return running;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

/**
 * Only a real `bash` evaluates the launcher, so interpreters without
 * background processes, such as `just-bash`, run the command directly.
 */
function launchCommand(command: string, directory: string): string {
  return [
    `if command -v bash >/dev/null 2>&1 && kill -0 "$$" 2>/dev/null; then`,
    `  set -- ${shellQuote(directory)} ${shellQuote(command)}`,
    `  eval ${shellQuote(LAUNCHER)}`,
    `fi`,
    `eval ${shellQuote(command)}`,
  ].join("\n");
}

/** Claims a still-running command for the model and reads its output so far. */
async function claimRunningJob(
  sandbox: SandboxSession,
  directory: string,
  jobId: string,
): Promise<BashResult | undefined> {
  const marker = `eve-bash:${jobId}`;
  const raw = await sandbox.run({
    command: [
      `cd ${shellQuote(directory)} 2>/dev/null && mkdir claimed 2>/dev/null || exit 0`,
      `kill -USR1 "$(cat launcher)" 2>/dev/null`,
      `printf '%s %s %s %s\\n' ${marker} "$(cat pid)" "$(($(wc -c < stdout)))" "$(($(wc -c < stderr)))"`,
      `tail -c ${MAX_OUTPUT_BYTES} stdout`,
      `tail -c ${MAX_OUTPUT_BYTES} stderr >&2`,
    ].join("\n"),
  });
  // Output a login profile prints comes before the marker.
  const match = new RegExp(`(?:^|\\n)${marker} (\\d+) (\\d+) (\\d+)\\n`).exec(raw.stdout);
  if (match === null) return undefined;
  const pid = Number(match[1]);
  const stdout = raw.stdout.slice(match.index + match[0].length);
  const omitted = {
    stderr: Math.max(0, Number(match[3]) - Buffer.byteLength(raw.stderr)),
    stdout: Math.max(0, Number(match[2]) - Buffer.byteLength(stdout)),
  };
  return {
    ...formatStreams({ stderr: raw.stderr, stdout }, omitted),
    message:
      `The command is still running after ${BASH_YIELD_SECONDS} seconds as process group ${pid}; stdout and stderr show its output so far. ` +
      `It keeps writing to ${directory}/stdout and ${directory}/stderr, and writes its exit code to ${directory}/exit when it finishes. ` +
      `Check on it with later commands such as \`tail ${directory}/stdout\` or \`cat ${directory}/exit\`, and stop it with \`kill -- -${pid}\`.`,
    outputDirectory: directory,
    pid,
    status: "running",
  };
}

async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new TextDecoder().decode(await streamToBuffer(stream));
}

async function waitUpTo<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function completed(exitCode: number, streams: RawStreams): BashResult {
  return { ...formatStreams(streams), exitCode, status: "completed" };
}

function formatStreams(
  streams: RawStreams,
  omittedBytes: { readonly stderr: number; readonly stdout: number } = { stderr: 0, stdout: 0 },
): BashStreams {
  const stdout = formatStream("stdout", streams.stdout, omittedBytes.stdout);
  const stderr = formatStream("stderr", streams.stderr, omittedBytes.stderr);
  return {
    stderr: stderr.output,
    stdout: stdout.output,
    truncated: stdout.truncated || stderr.truncated,
  };
}

function formatStream(
  name: "stderr" | "stdout",
  text: string,
  omittedBytes: number,
): { readonly output: string; readonly truncated: boolean } {
  const result = truncateTail(text);
  if (!result.truncated && omittedBytes === 0) {
    return { output: result.output, truncated: false };
  }
  const note =
    omittedBytes === 0
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
