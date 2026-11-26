import { randomUUID } from "node:crypto";

import { bashJobTaskWorkflowReference } from "#execution/sandbox/bash-job-reference.js";
import type { SandboxSession } from "#shared/sandbox-session.js";
import { runInternalCommand, spawnBoundedCommand } from "#execution/sandbox/internal-shell.js";
import { shellQuote } from "#execution/sandbox/shell-quote.js";
import {
  capLineLength,
  MAX_LINE_LENGTH,
  MAX_OUTPUT_BYTES,
  MAX_OUTPUT_LINES,
  truncateTail,
} from "#execution/sandbox/truncate-output.js";
import { isEveDevEnvironment } from "#internal/application/dev-environment.js";
import { TASK_CANCEL_TOOL_NAME } from "#protocol/task-tools.js";
import { canPromoteToTask, promoteToTask } from "#tools/task-handoff.js";

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
const STREAM_TAIL_THRESHOLD_BYTES = 512 * 1024;
const STREAM_TAIL_BYTES = MAX_OUTPUT_BYTES * 2;
const FALLBACK_KILL_GRACE_MS = 500;
const FALLBACK_FINISH_GRACE_MS = 2_000;
const JOB_TRAILER_PREFIX = "\0__eve_job__:";
const JOB_TRAILER_HOLD_CHARS = 96;

const LAUNCHER = `_eve_d=$1 _eve_cmd=$2 _eve_id=$3
shift 3
mkdir -p "$_eve_d" 2>/dev/null || { eval "$_eve_cmd"; exit; }
trap 'exit 0' USR1
echo "\${BASHPID:-$$}" > "$_eve_d/launcher"
set -m
(
  trap : TERM INT
  (unset _eve_d _eve_id; eval "$_eve_cmd") > "$_eve_d/stdout" 2> "$_eve_d/stderr"
  code=$?
  echo "$code" > "$_eve_d/exit.tmp" && mv -f "$_eve_d/exit.tmp" "$_eve_d/exit"
  exit "$code"
) < /dev/null > /dev/null 2>&1 &
pid=$!
set +m
echo "$pid" > "$_eve_d/pid"
wait "$pid" 2> /dev/null
code=$?
mkdir "$_eve_d/claimed" 2> /dev/null || exit 0
_eve_keep=0 _eve_out_lines=0 _eve_err_lines=0
if [ -s "$_eve_d/stdout" ]; then
  set -- $(wc -cl < "$_eve_d/stdout")
  _eve_out_lines=$1 _eve_out_bytes=$2
  if [ "$_eve_out_bytes" -gt ${STREAM_TAIL_THRESHOLD_BYTES} ]; then
    _eve_keep=1
    tail -c ${STREAM_TAIL_BYTES} "$_eve_d/stdout"
  else
    [ "$_eve_out_bytes" -gt ${KEEP_OUTPUT_BYTES} ] || [ "$_eve_out_lines" -gt ${KEEP_OUTPUT_LINES} ] && _eve_keep=1
    cat "$_eve_d/stdout"
  fi
fi
if [ -s "$_eve_d/stderr" ]; then
  set -- $(wc -cl < "$_eve_d/stderr")
  _eve_err_lines=$1 _eve_err_bytes=$2
  if [ "$_eve_err_bytes" -gt ${STREAM_TAIL_THRESHOLD_BYTES} ]; then
    _eve_keep=1
    tail -c ${STREAM_TAIL_BYTES} "$_eve_d/stderr" >&2
  else
    [ "$_eve_err_bytes" -gt ${KEEP_OUTPUT_BYTES} ] || [ "$_eve_err_lines" -gt ${KEEP_OUTPUT_LINES} ] && _eve_keep=1
    cat "$_eve_d/stderr" >&2
  fi
fi
if [ "$_eve_keep" -eq 0 ]; then
  rm -rf "$_eve_d"
else
  printf '\\0__eve_job__:%s:%s:%s\\0' "$_eve_id" "$_eve_out_lines" "$_eve_err_lines" >&2
fi
exit "$code"`;

export interface BashInput {
  readonly command: string;
  readonly timeout?: number;
}

export interface BashExecutionOptions {
  readonly abortSignal?: AbortSignal;
  readonly onTimeout?: "background" | "kill";
}

interface BashStreams {
  readonly stderr: string;
  readonly stdout: string;
  readonly truncated: boolean;
}

export type BashCompletedResult = BashStreams & {
  readonly status: "completed";
  readonly exitCode: number;
};

type BashRunningResult = BashStreams & {
  readonly status: "running";
  readonly pid: number;
  readonly outputDirectory: string;
  readonly message: string;
};

type BashResult = BashCompletedResult | BashRunningResult;

export interface BashJobHandoff {
  readonly directory: string;
  readonly pid: number;
}

type StreamTail =
  | { readonly text: string; readonly totalLines: number }
  | { readonly text: string; readonly omittedBytes: number };

interface StreamTails {
  readonly stderr: StreamTail;
  readonly stdout: StreamTail;
}

export function isBashJobHandoff(value: unknown): value is BashJobHandoff {
  if (typeof value !== "object" || value === null) return false;
  const directory = Reflect.get(value, "directory");
  const pid = Reflect.get(value, "pid");
  return typeof directory === "string" && directory.length > 0 && Number.isInteger(pid) && pid > 0;
}

export async function executeBashOnSandbox(
  sandbox: SandboxSession,
  args: BashInput,
  options: BashExecutionOptions = {},
): Promise<BashResult> {
  const command = formatCommand(args.command);
  logDevelopmentSandboxCommand(`eve: starting sandbox command: ${command}`);
  const waitSeconds = resolveBashWaitSeconds(args.timeout);
  const result = await withDevelopmentSandboxProgress(command, () =>
    runCommand(sandbox, args.command, waitSeconds, options.abortSignal, options.onTimeout),
  );
  logDevelopmentSandboxCommand(
    result.status === "running"
      ? `eve: sandbox command still running as pid ${result.pid}: ${command}`
      : `eve: sandbox command finished (exit ${result.exitCode}): ${command}`,
  );
  if (result.status === "running" && canPromoteToTask()) {
    const handoff: BashJobHandoff = { directory: result.outputDirectory, pid: result.pid };
    return promoteToTask<BashResult>({
      handoff: { ...handoff },
      onCancel: () => cancelBashJobOnSandbox(sandbox, handoff),
      preview: formatBashPromotionPreview(result, waitSeconds),
      workflowId: bashJobTaskWorkflowReference.workflowId,
    });
  }
  return result;
}

function resolveBashWaitSeconds(timeout: number | undefined): number {
  return timeout !== undefined && Number.isFinite(timeout)
    ? Math.min(Math.max(timeout, 1), BASH_MAX_YIELD_SECONDS)
    : BASH_YIELD_SECONDS;
}

function formatBashPromotionPreview(result: BashRunningResult, waitSeconds: number): string {
  const streams = [result.stdout, result.stderr && `[stderr]\n${result.stderr}`]
    .filter((stream) => stream.length > 0)
    .map((stream) => (stream.endsWith("\n") ? stream : `${stream}\n`))
    .join("\n");
  return (
    `${streams}` +
    `Still running after ${waitSeconds}s (pid ${result.pid}, output in ${result.outputDirectory}). ` +
    `Stop it with ${TASK_CANCEL_TOOL_NAME} if it appears hung.`
  );
}

function assertValidPid(pid: number): string {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new RangeError(`Expected a positive integer process group id, received ${String(pid)}.`);
  }
  return String(pid);
}

function buildStreamReadCommands(marker: string, quotedDir: string, codeExpr: string): string[] {
  return [
    `out_bytes="$(($(wc -c < stdout 2>/dev/null || echo 0)))"`,
    `out_lines="$(($(wc -l < stdout 2>/dev/null || echo 0)))"`,
    `err_bytes="$(($(wc -c < stderr 2>/dev/null || echo 0)))"`,
    `err_lines="$(($(wc -l < stderr 2>/dev/null || echo 0)))"`,
    `keep=0`,
    `[ "$out_bytes" -gt ${KEEP_OUTPUT_BYTES} ] || [ "$out_lines" -gt ${KEEP_OUTPUT_LINES} ] || [ "$err_bytes" -gt ${KEEP_OUTPUT_BYTES} ] || [ "$err_lines" -gt ${KEEP_OUTPUT_LINES} ] && keep=1`,
    `printf '%s done %s %s %s %s %s %s\\n' ${marker} ${codeExpr} "$out_bytes" "$out_lines" "$err_bytes" "$err_lines" "$keep"`,
    `tail -c ${MAX_OUTPUT_BYTES} stdout 2>/dev/null`,
    `tail -c ${MAX_OUTPUT_BYTES} stderr 2>/dev/null >&2`,
    `[ "$keep" -eq 0 ] && rm -rf ${quotedDir}`,
  ];
}

function killProcessGroupShell(pid: string): string {
  return `kill -TERM -- -${pid} 2>/dev/null; sleep 0.2; kill -KILL -- -${pid} 2>/dev/null`;
}

function streamTail(text: string, bytes: number, lines: number): StreamTail {
  const omittedBytes = Math.max(0, bytes - Buffer.byteLength(text));
  if (omittedBytes > 0) return { omittedBytes, text };
  return { text, totalLines: lines + (text.length > 0 && !text.endsWith("\n") ? 1 : 0) };
}

function parseReadStreamsOutput(
  raw: { readonly stdout: string; readonly stderr: string },
  marker: string,
  directory: string,
): { readonly exitCode: number; readonly streams: BashStreams } | undefined {
  const doneMatch = new RegExp(
    `(?:^|\\n)${marker} done (\\d+) (\\d+) (\\d+) (\\d+) (\\d+) (\\d+)\\n`,
  ).exec(raw.stdout);
  if (doneMatch === null) return undefined;
  const stdoutText = raw.stdout.slice(doneMatch.index + doneMatch[0].length);
  const tails: StreamTails = {
    stdout: streamTail(stdoutText, Number(doneMatch[2]), Number(doneMatch[3])),
    stderr: streamTail(raw.stderr, Number(doneMatch[4]), Number(doneMatch[5])),
  };
  return {
    exitCode: Number(doneMatch[1]),
    streams: formatStreams(tails, doneMatch[6] === "1" ? directory : undefined),
  };
}

export async function pollBashJobOnSandbox(
  sandbox: SandboxSession,
  handoff: BashJobHandoff,
): Promise<
  | { readonly status: "running" }
  | { readonly result: BashCompletedResult; readonly status: "completed" }
> {
  const pid = assertValidPid(handoff.pid);
  const marker = `eve-bash-poll:${randomUUID().slice(0, 8)}`;
  const quoted = shellQuote(handoff.directory);
  const raw = await runInternalCommand(sandbox, {
    command: [
      `cd ${quoted} 2>/dev/null || exit 0`,
      `if [ ! -s exit ] && kill -0 -- -${pid} 2>/dev/null; then printf '%s running\\n' ${marker}; exit 0; fi`,
      `code="$(cat exit 2>/dev/null)"`,
      `case "$code" in ''|*[!0-9]*) code=1 ;; esac`,
      ...buildStreamReadCommands(marker, quoted, '"$code"'),
    ].join("\n"),
  });
  if (new RegExp(`(?:^|\\n)${marker} running(?:\\n|$)`).test(raw.stdout)) {
    return { status: "running" };
  }
  const parsed = parseReadStreamsOutput(raw, marker, handoff.directory);
  if (parsed === undefined) {
    return {
      result: {
        exitCode: 1,
        status: "completed",
        stderr: `Process group ${handoff.pid} exited without an exit code.\n`,
        stdout: "",
        truncated: false,
      },
      status: "completed",
    };
  }
  return {
    result: {
      ...parsed.streams,
      exitCode: parsed.exitCode,
      status: "completed",
    },
    status: "completed",
  };
}

export async function cancelBashJobOnSandbox(
  sandbox: SandboxSession,
  handoff: BashJobHandoff,
  options: { readonly keepOutputDirectory?: boolean } = {},
): Promise<void> {
  const pid = assertValidPid(handoff.pid);
  const remove =
    options.keepOutputDirectory === true ? "" : `; rm -rf ${shellQuote(handoff.directory)}`;
  try {
    await runInternalCommand(sandbox, { command: `${killProcessGroupShell(pid)}${remove}` });
  } catch {}
}

export async function timeoutBashJobOnSandbox(
  sandbox: SandboxSession,
  handoff: BashJobHandoff,
  message: string,
): Promise<BashCompletedResult> {
  const pid = assertValidPid(handoff.pid);
  const marker = `eve-bash-timeout:${randomUUID().slice(0, 8)}`;
  const quoted = shellQuote(handoff.directory);
  try {
    const raw = await runInternalCommand(sandbox, {
      command: [
        killProcessGroupShell(pid),
        `cd ${quoted} 2>/dev/null || exit 0`,
        ...buildStreamReadCommands(marker, quoted, "124"),
      ].join("\n"),
    });
    const parsed = parseReadStreamsOutput(raw, marker, handoff.directory);
    if (parsed !== undefined) {
      const stderr = `${parsed.streams.stderr}${parsed.streams.stderr && !parsed.streams.stderr.endsWith("\n") ? "\n" : ""}${message}\n`;
      return {
        exitCode: 124,
        status: "completed",
        stderr,
        stdout: parsed.streams.stdout,
        truncated: parsed.streams.truncated,
      };
    }
  } catch {}
  return {
    exitCode: 124,
    status: "completed",
    stderr: `${message}\n`,
    stdout: "",
    truncated: false,
  };
}

async function runCommand(
  sandbox: SandboxSession,
  command: string,
  waitSeconds: number,
  signal: AbortSignal | undefined,
  onTimeout: "background" | "kill" = "background",
): Promise<BashResult> {
  signal?.throwIfAborted();
  const jobId = randomUUID().slice(0, 8);
  const directory = `${JOB_ROOT}/${jobId}`;
  const controller = new AbortController();
  const cancel = () => {
    controller.abort(signal?.reason);
    const quotedDir = shellQuote(directory);
    void Promise.resolve(
      runInternalCommand(sandbox, {
        command:
          `p="$(cat ${quotedDir}/pid 2>/dev/null)"; ` +
          `case "$p" in ''|*[!0-9]*) ;; *) kill -TERM -- -"$p" 2>/dev/null; sleep 0.2; kill -KILL -- -"$p" 2>/dev/null ;; esac; ` +
          `rm -rf ${quotedDir}`,
      }),
    ).catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const child = await spawnBoundedCommand(sandbox, {
      signal: controller.signal,
      command: launchCommand(command, directory, jobId),
    });
    const finished = Promise.all([
      readTail(child.stdout),
      readTail(child.stderr, jobId),
      child.wait(),
    ]).then(([stdout, stderr, { exitCode }]) => ({
      exitCode,
      jobTrailer: stderr.jobTrailer,
      stderr,
      stdout,
    }));
    const done = await waitUpTo(finished, waitSeconds * 1000);
    if (done !== undefined) return completed(directory, done);
    const running = await claimRunningJob(sandbox, directory, jobId, waitSeconds);
    if (running === undefined) {
      const raced = await waitUpTo(finished, FALLBACK_FINISH_GRACE_MS);
      if (raced !== undefined) return completed(directory, raced);
      const settled = finished.catch(() => undefined);
      await Promise.resolve(child.kill()).catch(() => {});
      let aborted = await waitUpTo(settled, FALLBACK_KILL_GRACE_MS);
      if (aborted === undefined) {
        controller.abort();
        aborted = await waitUpTo(settled, FALLBACK_FINISH_GRACE_MS);
      }
      if (signal?.aborted) throw signal.reason;
      if (aborted !== undefined) {
        return {
          ...formatStreams({
            stdout: aborted.stdout,
            stderr: {
              text: `${aborted.stderr.text}${aborted.stderr.text && !aborted.stderr.text.endsWith("\n") ? "\n" : ""}Command timed out after ${waitSeconds} seconds.\n`,
              totalLines: ("totalLines" in aborted.stderr ? aborted.stderr.totalLines : 0) + 1,
            },
          }),
          exitCode: aborted.exitCode !== 0 ? aborted.exitCode : 124,
          status: "completed",
        };
      }
      return {
        exitCode: 124,
        status: "completed",
        stderr: `Command timed out after ${waitSeconds} seconds.\n`,
        stdout: "",
        truncated: false,
      };
    }
    void finished.catch(() => {});
    if (onTimeout === "kill") {
      await cancelBashJobOnSandbox(
        sandbox,
        {
          directory: running.outputDirectory,
          pid: running.pid,
        },
        { keepOutputDirectory: running.truncated },
      );
      const stderr = `${running.stderr}${running.stderr && !running.stderr.endsWith("\n") ? "\n" : ""}Command timed out after ${waitSeconds} seconds and was killed.\n`;
      return {
        exitCode: 124,
        status: "completed",
        stderr,
        stdout: running.stdout,
        truncated: running.truncated,
      };
    }
    return running;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

function launchCommand(command: string, directory: string, jobId: string): string {
  return [
    `if command -v bash >/dev/null 2>&1 && kill -0 "$$" 2>/dev/null; then`,
    `  set -- ${shellQuote(directory)} ${shellQuote(command)} ${shellQuote(jobId)}`,
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
): Promise<BashRunningResult | undefined> {
  const marker = `eve-bash:${jobId}`;
  const raw = await runInternalCommand(sandbox, {
    command: [
      `cd ${shellQuote(directory)} 2>/dev/null || exit 0`,
      `i=0; while [ "$i" -lt 20 ] && { [ ! -s pid ] || [ ! -f stdout ] || [ ! -f stderr ]; }; do sleep 0.025; i=$((i+1)); done`,
      `[ -s pid ] && [ -f stdout ] && [ -f stderr ] && mkdir claimed 2>/dev/null || exit 0`,
      `kill -USR1 "$(cat launcher 2>/dev/null)" 2>/dev/null`,
      `printf '%s %s %s %s\\n' ${marker} "$(cat pid)" "$(($(wc -c < stdout)))" "$(($(wc -c < stderr)))"`,
      `tail -c ${MAX_OUTPUT_BYTES} stdout`,
      `tail -c ${MAX_OUTPUT_BYTES} stderr >&2`,
    ].join("\n"),
  });
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
      `If the command appears hung or unintended, stop it right away with \`kill -- -${pid}\` so it does not consume resources or hold locks. ` +
      `To wait for it in one call instead of polling, run \`while [ ! -e ${directory}/exit ] && kill -0 -- -${pid} 2>/dev/null; do sleep 1; done; cat ${directory}/exit 2>/dev/null || echo "process group ${pid} exited without an exit code"\` with a \`timeout\` of up to ${BASH_MAX_YIELD_SECONDS} seconds.`,
    outputDirectory: directory,
    pid,
    status: "running",
  };
}

interface JobTrailer {
  readonly stderrLines: number;
  readonly stdoutLines: number;
}

async function readTail(
  stream: ReadableStream<Uint8Array>,
  trailerJobId?: string,
): Promise<StreamTail & { readonly jobTrailer?: JobTrailer }> {
  const decoder = new TextDecoder();
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
  let jobTrailer: JobTrailer | undefined;
  if (trailerJobId === undefined) {
    for await (const chunk of stream) decode(decoder.decode(chunk, { stream: true }));
    decode(decoder.decode());
  } else {
    let pending = "";
    const push = (text: string) => {
      pending += text;
      if (pending.length > JOB_TRAILER_HOLD_CHARS) {
        const flush = pending.length - JOB_TRAILER_HOLD_CHARS;
        decode(pending.slice(0, flush));
        pending = pending.slice(flush);
      }
    };
    for await (const chunk of stream) push(decoder.decode(chunk, { stream: true }));
    pending += decoder.decode();
    const prefix = `${JOB_TRAILER_PREFIX}${trailerJobId}:`;
    const trailerStart = pending.lastIndexOf(prefix);
    if (trailerStart !== -1 && pending.endsWith("\0")) {
      const match = /^(\d+):(\d+)\0$/u.exec(pending.slice(trailerStart + prefix.length));
      if (match !== null) {
        jobTrailer = {
          stderrLines: Number(match[2]),
          stdoutLines: Number(match[1]),
        };
        pending = pending.slice(0, trailerStart);
      }
    }
    if (pending.length > 0) decode(pending);
  }
  const text = [...lines.slice(first).map((line) => line.text), current].join("\n");
  return { jobTrailer, text, totalLines: newlines + (current === "" ? 0 : 1) };
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

function completed(
  directory: string,
  {
    exitCode,
    jobTrailer,
    stderr,
    stdout,
  }: {
    readonly exitCode: number;
    readonly jobTrailer?: JobTrailer;
    readonly stderr: StreamTail;
    readonly stdout: StreamTail;
  },
): BashResult {
  const initial = formatStreamsWithFlags({ stderr, stdout });
  if ((initial.truncated || initial.lineTruncated) && jobTrailer !== undefined) {
    const adjusted: StreamTails = {
      stdout:
        "totalLines" in stdout
          ? { text: stdout.text, totalLines: Math.max(stdout.totalLines, jobTrailer.stdoutLines) }
          : stdout,
      stderr:
        "totalLines" in stderr
          ? { text: stderr.text, totalLines: Math.max(stderr.totalLines, jobTrailer.stderrLines) }
          : stderr,
    };
    return { ...formatStreams(adjusted, directory), exitCode, status: "completed" };
  }
  return {
    exitCode,
    status: "completed",
    stderr: initial.stderr,
    stdout: initial.stdout,
    truncated: initial.truncated,
  };
}

function formatStreams(streams: StreamTails, outputDirectory?: string): BashStreams {
  const formatted = formatStreamsWithFlags(streams, outputDirectory);
  return {
    stderr: formatted.stderr,
    stdout: formatted.stdout,
    truncated: formatted.truncated,
  };
}

function formatStreamsWithFlags(
  streams: StreamTails,
  outputDirectory?: string,
): BashStreams & { readonly lineTruncated: boolean } {
  const stdout = formatStream("stdout", streams.stdout, outputDirectory);
  const stderr = formatStream("stderr", streams.stderr, outputDirectory);
  return {
    stderr: stderr.output,
    stdout: stdout.output,
    truncated: stdout.truncated || stderr.truncated,
    lineTruncated: stdout.lineTruncated || stderr.lineTruncated,
  };
}

function formatStream(
  name: "stderr" | "stdout",
  tail: StreamTail,
  outputDirectory: string | undefined,
): { readonly output: string; readonly truncated: boolean; readonly lineTruncated: boolean } {
  const result = truncateTail(tail.text);
  const totalLines =
    "totalLines" in tail
      ? tail.totalLines
      : tail.omittedBytes === 0
        ? result.totalLines
        : undefined;
  if (totalLines !== undefined && result.outputLines >= totalLines) {
    if (result.lineTruncated && outputDirectory !== undefined) {
      return {
        output: `[${name} truncated: line exceeded ${MAX_LINE_LENGTH} chars; full output: ${outputDirectory}/${name}]\n${result.output}`,
        truncated: true,
        lineTruncated: true,
      };
    }
    return { output: result.output, truncated: false, lineTruncated: result.lineTruncated };
  }
  const shown =
    totalLines === undefined
      ? `showing last ${result.outputLines} lines`
      : `showing last ${result.outputLines} of ${totalLines} lines`;
  const rest = outputDirectory === undefined ? "" : `; full output: ${outputDirectory}/${name}`;
  return {
    output: `[${name} truncated: ${shown}${rest}]\n${result.output}`,
    truncated: true,
    lineTruncated: result.lineTruncated,
  };
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
