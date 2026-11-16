import { randomUUID } from "node:crypto";

import type { SandboxSession } from "#shared/sandbox-session.js";
import { shellQuote } from "#execution/sandbox/shell-quote.js";
import {
  capLineLength,
  MAX_LINE_LENGTH,
  MAX_OUTPUT_BYTES,
  MAX_OUTPUT_LINES,
  truncateTail,
} from "#execution/sandbox/truncate-output.js";
import { isEveDevEnvironment } from "#internal/application/dev-environment.js";

/** How long a `bash` call waits by default before it leaves the command running in the background. */
export const BASH_YIELD_SECONDS = 60;

/**
 * The longest a `bash` call waits. A hosted step runs a model call and its tool
 * calls in one Vercel function, which Hobby plans stop at 300 seconds, and a
 * function timeout loses the call's result, so the cap leaves room for the
 * model call, including its retries and long generations.
 */
export const BASH_MAX_YIELD_SECONDS = 120;

/** Where each command's output files live inside the sandbox. */
const JOB_ROOT = "/tmp/.eve/jobs";

const MAX_LOG_COMMAND_LENGTH = 240;

// A finished command keeps its job directory when a stream reaches the output
// limits, so the truncation note can point at the full output. `truncateTail`
// counts the empty line after a final newline and a newline byte per line,
// so a stream truncates once `wc` reaches either limit.
const KEEP_OUTPUT_BYTES = MAX_OUTPUT_BYTES - 1;
const KEEP_OUTPUT_LINES = MAX_OUTPUT_LINES - 1;

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
for f in "$d/stdout" "$d/stderr"; do
  [ "$(($(wc -c < "$f")))" -gt ${KEEP_OUTPUT_BYTES} ] || [ "$(($(wc -l < "$f")))" -gt ${KEEP_OUTPUT_LINES} ] && exit "$code"
done
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
  /**
   * Seconds to wait before leaving the command running in the background.
   * Defaults to {@link BASH_YIELD_SECONDS}, also for non-finite values;
   * clamped to 1 through {@link BASH_MAX_YIELD_SECONDS}.
   */
  readonly timeout?: number;
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

/**
 * The end of one output stream: enough of its last lines for `truncateTail`
 * to keep what it would keep from the whole stream of `totalLines` lines, or
 * its last bytes after `omittedBytes` bytes were dropped.
 */
type StreamTail =
  | { readonly text: string; readonly totalLines: number }
  | { readonly text: string; readonly omittedBytes: number };

interface StreamTails {
  readonly stderr: StreamTail;
  readonly stdout: StreamTail;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * Executes one shell command inside the agent's sandbox.
 *
 * A command that finishes within the wait, {@link BASH_YIELD_SECONDS} unless
 * `args.timeout` says otherwise, returns its exit code and output. A slower
 * command keeps running in the sandbox as its own
 * process group, writing to files the model reads with later commands, and
 * the call returns its output so far with `status: "running"`. Sandboxes that
 * cannot run background processes, such as `just-bash`, run every command to
 * completion.
 *
 * Both stdout and stderr are tail-truncated to keep the end of the output
 * (where errors and final results typically appear) within the shared
 * output limits. A truncated stream's note names the file with its full
 * output when the sandbox kept it.
 */
export async function executeBashOnSandbox(
  sandbox: SandboxSession,
  args: BashInput,
  options: BashExecutionOptions = {},
): Promise<BashResult> {
  const command = formatCommand(args.command);
  logDevelopmentSandboxCommand(`eve: starting sandbox command: ${command}`);
  const { timeout } = args;
  const waitSeconds =
    timeout !== undefined && Number.isFinite(timeout)
      ? Math.min(Math.max(timeout, 1), BASH_MAX_YIELD_SECONDS)
      : BASH_YIELD_SECONDS;
  const result = await withDevelopmentSandboxProgress(command, () =>
    runCommand(sandbox, args.command, waitSeconds, options.abortSignal),
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
  waitSeconds: number,
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
      signal: controller.signal,
      command: launchCommand(command, directory),
    });
    const finished = Promise.all([
      readTail(child.stdout),
      readTail(child.stderr),
      child.wait(),
    ]).then(([stdout, stderr, { exitCode }]) => ({ exitCode, stderr, stdout }));
    const done = await waitUpTo(finished, waitSeconds * 1000);
    if (done !== undefined) return await completed(sandbox, directory, done);
    const running = await claimRunningJob(sandbox, directory, jobId, waitSeconds);
    if (running === undefined) {
      // No job to claim: the sandbox cannot run background processes, or
      // the command finished as the yield began.
      return await completed(sandbox, directory, await finished);
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
  waitSeconds: number,
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
  const tails = {
    stderr: {
      omittedBytes: Math.max(0, Number(match[3]) - Buffer.byteLength(raw.stderr)),
      text: raw.stderr,
    },
    stdout: {
      omittedBytes: Math.max(0, Number(match[2]) - Buffer.byteLength(stdout)),
      text: stdout,
    },
  };
  return {
    ...formatStreams(tails, directory),
    message:
      `The command is still running after ${waitSeconds} seconds as process group ${pid}; this result includes its output so far. ` +
      `It keeps writing to ${directory}/stdout and ${directory}/stderr, and writes its exit code to ${directory}/exit when it finishes. ` +
      `Check on it with later commands such as \`tail ${directory}/stdout\` or \`cat ${directory}/exit\`, and stop it with \`kill -- -${pid}\`. ` +
      `To wait for it in one call instead of polling, run \`while [ ! -e ${directory}/exit ] && kill -0 -- -${pid} 2>/dev/null; do sleep 1; done; cat ${directory}/exit 2>/dev/null || echo "process group ${pid} exited without an exit code"\` with a \`timeout\` of up to ${BASH_MAX_YIELD_SECONDS} seconds.`,
    outputDirectory: directory,
    pid,
    status: "running",
  };
}

/**
 * Drains `stream` keeping only the lines `truncateTail` could still keep from
 * the whole stream, each cut to the start `capLineLength` keeps, so memory
 * stays bounded however much a command prints.
 */
async function readTail(stream: ReadableStream<Uint8Array>): Promise<StreamTail> {
  const decoder = new TextDecoder();
  // Finished lines from `first` on, each with its byte size once capped plus its newline.
  const lines: { readonly text: string; readonly bytes: number }[] = [];
  let first = 0;
  let keptBytes = 0;
  let current = "";
  let newlines = 0;
  const append = (text: string) => {
    if (current.length <= MAX_LINE_LENGTH)
      current += text.slice(0, MAX_LINE_LENGTH + 1 - current.length);
  };
  const finishLine = () => {
    const bytes = Buffer.byteLength(capLineLength(current)) + 1;
    lines.push({ bytes, text: current });
    keptBytes += bytes;
    current = "";
    newlines++;
    // The oldest line is out of reach once the newer finished lines alone
    // fill either budget: `truncateTail` always keeps the last line too.
    while (
      keptBytes - lines[first]!.bytes > MAX_OUTPUT_BYTES ||
      lines.length - first > MAX_OUTPUT_LINES
    ) {
      keptBytes -= lines[first]!.bytes;
      first++;
    }
    if (first > lines.length - first) {
      lines.splice(0, first);
      first = 0;
    }
  };
  const decode = (text: string) => {
    let start = 0;
    for (let end = text.indexOf("\n"); end !== -1; end = text.indexOf("\n", start)) {
      append(text.slice(start, end));
      finishLine();
      start = end + 1;
    }
    append(text.slice(start));
  };
  for await (const chunk of stream) decode(decoder.decode(chunk, { stream: true }));
  decode(decoder.decode());
  const text = [...lines.slice(first).map((line) => line.text), current].join("\n");
  // `truncateTail` counts no line after a final newline.
  return { text, totalLines: newlines + (current === "" ? 0 : 1) };
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

async function completed(
  sandbox: SandboxSession,
  directory: string,
  {
    exitCode,
    stderr,
    stdout,
  }: { readonly exitCode: number; readonly stderr: StreamTail; readonly stdout: StreamTail },
): Promise<BashResult> {
  let streams = formatStreams({ stderr, stdout });
  // Only a truncated result needs the files, and a sandbox without the
  // launcher, such as `just-bash`, never writes them.
  if (streams.truncated && (await hasJobOutput(sandbox, directory))) {
    streams = formatStreams({ stderr, stdout }, directory);
  }
  return { ...streams, exitCode, status: "completed" };
}

async function hasJobOutput(sandbox: SandboxSession, directory: string): Promise<boolean> {
  try {
    const result = await sandbox.run({ command: `test -f ${shellQuote(directory)}/stdout` });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

function formatStreams(streams: StreamTails, outputDirectory?: string): BashStreams {
  const stdout = formatStream("stdout", streams.stdout, outputDirectory);
  const stderr = formatStream("stderr", streams.stderr, outputDirectory);
  return {
    stderr: stderr.output,
    stdout: stdout.output,
    truncated: stdout.truncated || stderr.truncated,
  };
}

function formatStream(
  name: "stderr" | "stdout",
  tail: StreamTail,
  outputDirectory: string | undefined,
): { readonly output: string; readonly truncated: boolean } {
  const result = truncateTail(tail.text);
  const totalLines =
    "totalLines" in tail
      ? tail.totalLines
      : tail.omittedBytes === 0
        ? result.totalLines
        : undefined;
  if (totalLines !== undefined && result.outputLines >= totalLines) {
    return { output: result.output, truncated: false };
  }
  const shown =
    totalLines === undefined
      ? `showing last ${result.outputLines} lines`
      : `showing last ${result.outputLines} of ${totalLines} lines`;
  const rest = outputDirectory === undefined ? "" : `; full output: ${outputDirectory}/${name}`;
  return { output: `[${name} truncated: ${shown}${rest}]\n${result.output}`, truncated: true };
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
