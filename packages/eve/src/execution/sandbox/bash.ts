import { randomUUID } from "node:crypto";

import type { SandboxSession } from "#shared/sandbox-session.js";
import { shellQuote } from "#execution/sandbox/shell-quote.js";
import {
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

const JOB_ROOT = "/tmp/.eve/jobs";

const MAX_LOG_COMMAND_LENGTH = 240;

const KEEP_OUTPUT_BYTES = MAX_OUTPUT_BYTES - 1;
const KEEP_OUTPUT_LINES = MAX_OUTPUT_LINES - 1;

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

export interface BashInput {
  readonly command: string;
  readonly timeout?: number;
}

export interface BashExecutionOptions {
  readonly abortSignal?: AbortSignal;
}

interface BashStreams {
  readonly stderr: string;
  readonly stdout: string;
  readonly truncated: boolean;
}

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

interface StreamTail {
  readonly omittedBytes: number;
  readonly text: string;
}

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
  const controller = new AbortController();
  const cancel = () => {
    controller.abort(signal?.reason);
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
      return await completed(sandbox, directory, await finished);
    }
    void finished.catch(() => {});
    return running;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

function launchCommand(command: string, directory: string): string {
  return [
    `if command -v bash >/dev/null 2>&1 && kill -0 "$$" 2>/dev/null; then`,
    `  set -- ${shellQuote(directory)} ${shellQuote(command)}`,
    `  eval ${shellQuote(LAUNCHER)}`,
    `fi`,
    `eval ${shellQuote(command)}`,
  ].join("\n");
}

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
  const match = new RegExp(`(?:^|\\n)${marker} (\\d+) (\\d+) (\\d+)\\n`).exec(raw.stdout);
  if (match === null) return undefined;
  const pid = Number(match[1]);
  const stdout = raw.stdout.slice(match.index + match[0].length);
  const omitted = {
    stderr: Math.max(0, Number(match[3]) - Buffer.byteLength(raw.stderr)),
    stdout: Math.max(0, Number(match[2]) - Buffer.byteLength(stdout)),
  };
  return {
    ...formatStreams({ stderr: raw.stderr, stdout }, omitted, directory),
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

async function readTail(stream: ReadableStream<Uint8Array>): Promise<StreamTail> {
  let chunks: Uint8Array[] = [];
  let bytes = 0;
  let omittedBytes = 0;
  const keepTail = () => {
    const tail = Buffer.concat(chunks).subarray(-MAX_OUTPUT_BYTES);
    omittedBytes += bytes - tail.byteLength;
    chunks = [tail];
    bytes = tail.byteLength;
    return tail;
  };
  for await (const chunk of stream) {
    chunks.push(chunk);
    bytes += chunk.byteLength;
    if (bytes > 2 * MAX_OUTPUT_BYTES) keepTail();
  }
  const text = new TextDecoder().decode(keepTail());
  return { omittedBytes, text };
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
  const raw = { stderr: stderr.text, stdout: stdout.text };
  const omitted = { stderr: stderr.omittedBytes, stdout: stdout.omittedBytes };
  let streams = formatStreams(raw, omitted);
  if (streams.truncated && (await hasJobOutput(sandbox, directory))) {
    streams = formatStreams(raw, omitted, directory);
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

function formatStreams(
  streams: RawStreams,
  omittedBytes: { readonly stderr: number; readonly stdout: number },
  outputDirectory?: string,
): BashStreams {
  const stdout = formatStream("stdout", streams.stdout, omittedBytes.stdout, outputDirectory);
  const stderr = formatStream("stderr", streams.stderr, omittedBytes.stderr, outputDirectory);
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
  outputDirectory: string | undefined,
): { readonly output: string; readonly truncated: boolean } {
  const result = truncateTail(text);
  if (!result.truncated && omittedBytes === 0) {
    return { output: result.output, truncated: false };
  }
  const shown =
    omittedBytes === 0
      ? `showing last ${result.outputLines} of ${result.totalLines} lines`
      : `showing last ${result.outputLines} lines`;
  const rest =
    outputDirectory === undefined
      ? omittedBytes === 0
        ? ""
        : "; earlier output omitted"
      : `; full output: ${outputDirectory}/${name}`;
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
