import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { withoutCodingAgentMarkers } from "./coding-agent-env.js";
import { createProcessOutputBuffer, type ProcessOutputHandler } from "./process-output.js";
import { armProcessAbort } from "./process-abort.js";

const CONNECT_FEATURE_FLAG_ENV: Readonly<Record<string, string>> = {
  FF_CONNECT_ENABLED: "1",
};

const VERCEL_NOT_FOUND_MESSAGE = "Vercel CLI not found. Install with: npm i -g vercel@latest";

function buildSpawnEnv(extraEnv: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  // Strip coding-agent launch markers so the Vercel CLI never reacts to an
  // agent it was not driving: eve invokes it explicitly (stdin, flags), and an
  // inherited marker has turned a read-only `vercel whoami` into a login
  // attempt. eve's own agent detection reads `process.env` directly, so this
  // only changes what the child sees.
  return { ...withoutCodingAgentMarkers(process.env), ...CONNECT_FEATURE_FLAG_ENV, ...extraEnv };
}

function commandArgs(args: string[], nonInteractive: boolean | undefined): string[] {
  if (!nonInteractive || args.includes("--non-interactive")) return args;
  return [...args, "--non-interactive"];
}

/**
 * Nearest existing directory at or above `dir`. The create flow runs
 * account-level vercel lookups (whoami, teams, gateway) from the project's
 * parent before it is scaffolded, so that path may not exist yet, and spawning
 * a child with a missing `cwd` throws ENOENT. Walking up keeps those
 * cwd-independent lookups working; an existing `dir` (every post-scaffold,
 * project-scoped call) is returned unchanged.
 */
function existingDir(dir: string): string {
  let current = resolve(dir);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

/** Options common to shared Vercel CLI subprocess operations. */
export interface RunVercelOptions {
  cwd: string;
  extraEnv?: Readonly<Record<string, string>>;
  /** Pass `--non-interactive` and close stdin so automation cannot stop on a prompt. */
  nonInteractive?: boolean;
  /** UTF-8 data written to stdin, used to keep connector secrets out of argv. */
  stdin?: string;
  /** Streams command output to a parent-owned renderer instead of writing outside it. */
  onOutput?: ProcessOutputHandler;
  /** Aborts the Vercel CLI subprocess when its parent setup flow is interrupted. */
  signal?: AbortSignal;
  /**
   * Hard deadline for the whole command. When it elapses the run settles as a
   * failure and the child is killed (SIGTERM, then SIGKILL after a short
   * grace). Unbounded when omitted — only safe for commands that cannot wait
   * on external action, e.g. a Connect create parked on a browser OAuth.
   */
  timeoutMs?: number;
}

const KILL_GRACE_MS = 5_000;

/**
 * Arms the `timeoutMs` deadline on a spawned CLI child. `onTimeout` fires
 * first so the caller can settle its promise with a failure before the kill;
 * the SIGKILL escalation covers a CLI that ignores SIGTERM. Timers are
 * unref'd so a finished parent never lingers on them. Returns a disarm
 * function for the close handler.
 */
function armDeadline(
  child: ChildProcess,
  timeoutMs: number | undefined,
  onTimeout: () => void,
): () => void {
  if (timeoutMs === undefined) return () => {};
  const deadline = setTimeout(() => {
    onTimeout();
    child.kill("SIGTERM");
    const hardKill = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    hardKill.unref();
    child.once("close", () => clearTimeout(hardKill));
  }, timeoutMs);
  deadline.unref();
  return () => clearTimeout(deadline);
}

function timeoutMessage(args: string[], timeoutMs: number): string {
  return `vercel ${args.join(" ")} timed out after ${Math.round(timeoutMs / 1000)}s and was aborted.`;
}

function abortMessage(args: string[]): string {
  return `vercel ${args.join(" ")} was aborted.`;
}

function isAbortError(error: NodeJS.ErrnoException, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || error.name === "AbortError" || error.code === "ABORT_ERR";
}

interface VercelCliInvocation {
  command: string;
  commandArgs: string[];
  shell?: boolean;
}

type Platform = NodeJS.Platform;

function ancestorDirectories(dir: string): string[] {
  const directories: string[] = [];
  let current = resolve(dir);
  while (true) {
    directories.push(current);
    const parent = dirname(current);
    if (parent === current) return directories;
    current = parent;
  }
}

function findExecutable(filePath: string): string | undefined {
  try {
    accessSync(filePath, constants.F_OK | constants.X_OK);
    if (statSync(filePath).isFile()) return filePath;
  } catch {
    return undefined;
  }
  return undefined;
}

function vercelExecutableNames(platform: Platform): string[] {
  return platform === "win32" ? ["vercel.cmd", "vercel.exe"] : ["vercel"];
}

function findLocalVercel(cwd: string, platform: Platform): string | undefined {
  for (const dir of ancestorDirectories(cwd)) {
    for (const executable of vercelExecutableNames(platform)) {
      const binary = findExecutable(join(dir, "node_modules", ".bin", executable));
      if (binary !== undefined) return binary;
    }
  }
  return undefined;
}

export function resolveVercelInvocation(
  cwd: string,
  args: string[] = [],
  platform: Platform = process.platform,
): VercelCliInvocation {
  const localBinary = findLocalVercel(cwd, platform);
  if (platform === "win32") {
    return { command: localBinary ?? "vercel", commandArgs: args, shell: true };
  }
  return localBinary === undefined
    ? { command: "vercel", commandArgs: args }
    : { command: localBinary, commandArgs: args };
}

function stdinMode(options: RunVercelOptions): "inherit" | "ignore" | "pipe" {
  if (options.stdin !== undefined) return "pipe";
  return options.nonInteractive ? "ignore" : "inherit";
}

function writeStdin(
  child: ChildProcess,
  input: string | undefined,
  onError: (error: NodeJS.ErrnoException) => void,
): void {
  if (input === undefined || child.stdin === null) return;
  child.stdin.once("error", onError);
  child.stdin.end(input, "utf8");
}

function stdioForRun(
  options: RunVercelOptions,
): ["inherit" | "ignore" | "pipe", "pipe", "pipe"] | "inherit" {
  if (options.onOutput || options.stdin !== undefined) {
    return [stdinMode(options), "pipe", "pipe"];
  }
  return options.nonInteractive ? ["ignore", "pipe", "pipe"] : "inherit";
}

type StdioChannel = "inherit" | "ignore" | "pipe";

/** stdio layout for a Vercel CLI child: fully inherited, or per channel. */
type VercelStdio = "inherit" | [StdioChannel, StdioChannel, StdioChannel];

/** Why a run failed, carried so a caller can act on the cause. */
interface VercelRunFailure {
  code?: number | null;
  errno?: string;
  message: string;
}

/** Terminal state of one Vercel CLI run, before it is shaped for the caller. */
type VercelRunOutcome =
  | { ok: true; stdout: string; stderr: string }
  | ({ ok: false; stdout: string; stderr: string } & VercelRunFailure);

/** How a public entry point drives the shared run and shapes its result. */
interface VercelRunSpec<T> {
  stdio: VercelStdio;
  /**
   * Retain stdout and stderr for the caller. When false, stdout is streamed to
   * the renderer instead and neither stream is kept in memory.
   */
  capture: boolean;
  /** Write diagnostics to `process.stderr` when no renderer is attached. */
  reportWithoutRenderer: boolean;
  result(outcome: VercelRunOutcome): T;
}

/**
 * Runs the Vercel CLI with the Connect feature flag enabled and settles exactly
 * once, whatever ends the run: a clean exit, a non-zero exit, a spawn error, a
 * failed stdin write, the `timeoutMs` deadline, or cancellation. Every public
 * entry point shares this lifecycle and differs only in its stdio layout and
 * result shape.
 *
 * A settled run flushes buffered output before its diagnostic so a partial
 * trailing line cannot appear after the failure it preceded. Cancellation and a
 * signal-driven exit stay silent: the timeout that killed the child has already
 * reported, and a user-driven abort is not a fault to narrate.
 */
function runVercelProcess<T>(
  args: string[],
  options: RunVercelOptions,
  spec: VercelRunSpec<T>,
): Promise<T> {
  if (options.signal?.aborted === true) {
    return Promise.resolve(
      spec.result({
        ok: false,
        stdout: "",
        stderr: "",
        errno: "ABORT_ERR",
        message: abortMessage(args),
      }),
    );
  }
  return new Promise<T>((resolvePromise) => {
    const cwd = existingDir(options.cwd);
    const invocation = resolveVercelInvocation(cwd, commandArgs(args, options.nonInteractive));
    const outputBuffer = options.onOutput && createProcessOutputBuffer(options.onOutput);
    const child = spawn(invocation.command, invocation.commandArgs, {
      cwd,
      stdio: spec.stdio,
      env: buildSpawnEnv(options.extraEnv ?? {}),
      shell: invocation.shell,
      signal: options.signal,
    });
    const disarmAbort = armProcessAbort(child, options.signal);
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    child.stdout?.on("data", (chunk: Buffer) => {
      if (spec.capture) stdoutChunks.push(chunk.toString("utf8"));
      else outputBuffer?.write("stdout", chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (spec.capture) stderrChunks.push(chunk.toString("utf8"));
      outputBuffer?.write("stderr", chunk);
    });

    let settled = false;
    function settle(outcome: VercelRunOutcome, report: boolean): void {
      if (settled) return;
      settled = true;
      outputBuffer?.flush();
      if (report && !outcome.ok) {
        if (options.onOutput !== undefined) {
          options.onOutput({ stream: "stderr", text: outcome.message });
        } else if (spec.reportWithoutRenderer) {
          process.stderr.write(`\n${outcome.message}\n`);
        }
      }
      resolvePromise(spec.result(outcome));
    }
    function captured(): { stdout: string; stderr: string } {
      return { stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") };
    }
    function fail(failure: VercelRunFailure, report = true): void {
      settle({ ok: false, ...captured(), ...failure }, report);
    }

    const disarmDeadline = armDeadline(child, options.timeoutMs, () => {
      fail({ code: null, message: timeoutMessage(args, options.timeoutMs ?? 0) });
    });
    writeStdin(child, options.stdin, (error) => {
      fail({
        errno: error.code,
        message: `vercel ${args.join(" ")} stdin failed: ${error.message}`,
      });
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (isAbortError(error, options.signal)) return;
      disarmAbort();
      disarmDeadline();
      fail({
        errno: error.code,
        message:
          error.code === "ENOENT"
            ? VERCEL_NOT_FOUND_MESSAGE
            : `vercel ${args.join(" ")} failed: ${error.message}`,
      });
    });
    child.on("close", (code) => {
      disarmAbort();
      disarmDeadline();
      if (options.signal?.aborted === true) {
        fail({ code, errno: "ABORT_ERR", message: abortMessage(args) }, false);
        return;
      }
      if (code === 0) {
        settle({ ok: true, ...captured() }, false);
        return;
      }
      fail(
        code === null
          ? { code, message: abortMessage(args) }
          : { code, message: `vercel ${args.join(" ")} exited with code ${code}.` },
        code !== null,
      );
    });
  });
}

/**
 * Runs a Vercel CLI command with the Connect feature flag enabled.
 *
 * When `onOutput` is supplied, stdout and stderr are emitted as complete lines
 * so an interactive parent can keep terminal rendering coherent.
 */
export async function runVercel(args: string[], options: RunVercelOptions): Promise<boolean> {
  return runVercelProcess(args, options, {
    stdio: stdioForRun(options),
    capture: false,
    reportWithoutRenderer: true,
    result: (outcome) => outcome.ok,
  });
}

/** Exit success plus captured stdout from an interactive Vercel CLI run. */
export interface RunVercelCaptureResult {
  ok: boolean;
  stdout: string;
  stderr?: string;
}

/**
 * Runs an interactive Vercel CLI command while capturing its stdout.
 *
 * Unlike {@link captureVercel}, stdin stays attached to the terminal so the
 * command can drive prompts and browser-based OAuth flows, and stderr is
 * streamed to `onOutput` (the rail renderer) like {@link runVercel}. Only
 * stdout is captured, so a `--format json` payload can be parsed without
 * disturbing the interactive UI, which the Vercel CLI writes to stderr.
 */
export async function runVercelCaptureStdout(
  args: string[],
  options: RunVercelOptions,
): Promise<RunVercelCaptureResult> {
  return runVercelProcess(args, options, {
    stdio: [stdinMode(options), "pipe", options.onOutput ? "pipe" : "inherit"],
    capture: true,
    reportWithoutRenderer: true,
    result: ({ ok, stdout, stderr }) =>
      stderr.length === 0 ? { ok, stdout } : { ok, stdout, stderr },
  });
}

/** Why a {@link captureVercel} lookup failed, preserved so callers can act on it. */
export interface VercelCaptureFailure {
  /** Process exit code, or `null` when killed by a signal; absent for a spawn error (the process never ran). */
  code?: number | null;
  /** `error.code` from a spawn failure, e.g. `"ENOENT"` when `vercel` is not on `PATH`. */
  errno?: string;
  /** Captured stderr (best-effort); empty when the process never ran. */
  stderr: string;
  /** Captured stdout (best-effort), useful when a JSON API error exits non-zero. */
  stdout: string;
  /** One-line human-readable summary, safe to surface to a user or agent. */
  message: string;
}

/**
 * Outcome of a {@link captureVercel} lookup: stdout on a clean exit, or the
 * failure diagnostic. The failure arm exists so a caller like the login check
 * can tell "not logged in" from "the CLI is missing" or "the API errored",
 * instead of collapsing every fault into a single `undefined`.
 */
export type VercelCaptureResult =
  | { ok: true; stdout: string }
  | { ok: false; failure: VercelCaptureFailure };

/**
 * Runs a Vercel CLI lookup and captures stdout.
 *
 * stderr is always captured so a failure's diagnostic survives, even with no
 * live `onOutput` renderer attached; when `onOutput` is supplied, stderr is
 * streamed to it and the failure summary is appended after a non-zero exit.
 */
/** Shapes a failed run as the diagnostic {@link captureVercel} callers act on. */
function toCaptureFailure(outcome: Extract<VercelRunOutcome, { ok: false }>): VercelCaptureFailure {
  const failure: VercelCaptureFailure = {
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    message: outcome.message,
  };
  if (outcome.code !== undefined) failure.code = outcome.code;
  if (outcome.errno !== undefined) failure.errno = outcome.errno;
  return failure;
}

export async function captureVercel(
  args: string[],
  options: RunVercelOptions,
): Promise<VercelCaptureResult> {
  return runVercelProcess(args, options, {
    stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    capture: true,
    reportWithoutRenderer: false,
    result: (outcome) =>
      outcome.ok
        ? { ok: true, stdout: outcome.stdout }
        : { ok: false, failure: toCaptureFailure(outcome) },
  });
}
