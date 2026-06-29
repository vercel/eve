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

function stdioForRun(
  options: RunVercelOptions,
): ["inherit" | "ignore", "pipe", "pipe"] | "inherit" {
  if (options.onOutput) {
    return [options.nonInteractive ? "ignore" : "inherit", "pipe", "pipe"];
  }
  return options.nonInteractive ? ["ignore", "pipe", "pipe"] : "inherit";
}

/**
 * Runs a Vercel CLI command with the Connect feature flag enabled.
 *
 * When `onOutput` is supplied, stdout and stderr are emitted as complete lines
 * so an interactive parent can keep terminal rendering coherent.
 */
export async function runVercel(args: string[], options: RunVercelOptions): Promise<boolean> {
  if (options.signal?.aborted === true) return false;
  return new Promise<boolean>((resolvePromise) => {
    const cwd = existingDir(options.cwd);
    const invocation = resolveVercelInvocation(cwd, commandArgs(args, options.nonInteractive));
    const outputBuffer = options.onOutput && createProcessOutputBuffer(options.onOutput);
    const child = spawn(invocation.command, invocation.commandArgs, {
      cwd,
      stdio: stdioForRun(options),
      env: buildSpawnEnv(options.extraEnv ?? {}),
      shell: invocation.shell,
      signal: options.signal,
    });
    const disarmAbort = armProcessAbort(child, options.signal);
    child.stdout?.on("data", (chunk: Buffer) => outputBuffer?.write("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => outputBuffer?.write("stderr", chunk));

    let settled = false;
    function settle(success: boolean): void {
      if (settled) return;
      settled = true;
      outputBuffer?.flush();
      resolvePromise(success);
    }
    function reportFailure(message: string): void {
      if (options.onOutput) {
        options.onOutput({ stream: "stderr", text: message });
      } else {
        process.stderr.write(`\n${message}\n`);
      }
    }

    const disarmDeadline = armDeadline(child, options.timeoutMs, () => {
      reportFailure(timeoutMessage(args, options.timeoutMs ?? 0));
      settle(false);
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (isAbortError(error, options.signal)) {
        return;
      } else if (error.code === "ENOENT") {
        disarmAbort();
        disarmDeadline();
        reportFailure(VERCEL_NOT_FOUND_MESSAGE);
        settle(false);
      } else {
        disarmAbort();
        disarmDeadline();
        reportFailure(`vercel ${args.join(" ")} failed: ${error.message}`);
        settle(false);
      }
    });
    child.on("close", (code) => {
      disarmAbort();
      disarmDeadline();
      if (options.signal?.aborted === true) {
        settle(false);
        return;
      }
      // After a timeout has settled the run, the eventual kill-driven exit
      // must not inject a second, stale diagnostic into the renderer.
      if (!settled && code !== 0 && code !== null) {
        outputBuffer?.flush();
        reportFailure(`vercel ${args.join(" ")} exited with code ${code}.`);
      }
      settle(code === 0);
    });
  });
}

/** Exit success plus captured stdout from an interactive Vercel CLI run. */
export interface RunVercelCaptureResult {
  ok: boolean;
  stdout: string;
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
  if (options.signal?.aborted === true) return { ok: false, stdout: "" };
  return new Promise<RunVercelCaptureResult>((resolvePromise) => {
    const cwd = existingDir(options.cwd);
    const invocation = resolveVercelInvocation(cwd, commandArgs(args, options.nonInteractive));
    const outputBuffer = options.onOutput && createProcessOutputBuffer(options.onOutput);
    const child = spawn(invocation.command, invocation.commandArgs, {
      cwd,
      stdio: [
        options.nonInteractive ? "ignore" : "inherit",
        "pipe",
        options.onOutput ? "pipe" : "inherit",
      ],
      env: buildSpawnEnv(options.extraEnv ?? {}),
      shell: invocation.shell,
      signal: options.signal,
    });
    const disarmAbort = armProcessAbort(child, options.signal);
    const chunks: string[] = [];
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => outputBuffer?.write("stderr", chunk));

    let settled = false;
    function settle(ok: boolean): void {
      if (settled) return;
      settled = true;
      outputBuffer?.flush();
      resolvePromise({ ok, stdout: chunks.join("") });
    }
    function reportFailure(message: string): void {
      if (options.onOutput) {
        options.onOutput({ stream: "stderr", text: message });
      } else {
        process.stderr.write(`\n${message}\n`);
      }
    }

    const disarmDeadline = armDeadline(child, options.timeoutMs, () => {
      reportFailure(timeoutMessage(args, options.timeoutMs ?? 0));
      settle(false);
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (isAbortError(error, options.signal)) {
        return;
      }
      disarmAbort();
      disarmDeadline();
      reportFailure(
        error.code === "ENOENT"
          ? VERCEL_NOT_FOUND_MESSAGE
          : `vercel ${args.join(" ")} failed: ${error.message}`,
      );
      settle(false);
    });
    child.on("close", (code) => {
      disarmAbort();
      disarmDeadline();
      if (options.signal?.aborted === true) {
        settle(false);
        return;
      }
      // After a timeout has settled the run, the eventual kill-driven exit
      // must not inject a second, stale diagnostic into the renderer.
      if (!settled && code !== 0 && code !== null) {
        reportFailure(`vercel ${args.join(" ")} exited with code ${code}.`);
      }
      settle(code === 0);
    });
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
export async function captureVercel(
  args: string[],
  options: RunVercelOptions,
): Promise<VercelCaptureResult> {
  if (options.signal?.aborted === true) {
    return {
      ok: false,
      failure: {
        errno: "ABORT_ERR",
        stdout: "",
        stderr: "",
        message: abortMessage(args),
      },
    };
  }
  return new Promise<VercelCaptureResult>((resolvePromise) => {
    const cwd = existingDir(options.cwd);
    const invocation = resolveVercelInvocation(cwd, commandArgs(args, options.nonInteractive));
    const outputBuffer = options.onOutput && createProcessOutputBuffer(options.onOutput);
    const child = spawn(invocation.command, invocation.commandArgs, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: buildSpawnEnv(options.extraEnv ?? {}),
      shell: invocation.shell,
      signal: options.signal,
    });
    const disarmAbort = armProcessAbort(child, options.signal);
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk.toString("utf8"));
      outputBuffer?.write("stderr", chunk);
    });

    let settled = false;
    function fail(failure: VercelCaptureFailure, report = true): void {
      if (settled) return;
      settled = true;
      outputBuffer?.flush();
      if (report) options.onOutput?.({ stream: "stderr", text: failure.message });
      resolvePromise({ ok: false, failure });
    }
    function succeed(): void {
      if (settled) return;
      settled = true;
      outputBuffer?.flush();
      resolvePromise({ ok: true, stdout: stdoutChunks.join("") });
    }

    const disarmDeadline = armDeadline(child, options.timeoutMs, () => {
      fail({
        code: null,
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        message: timeoutMessage(args, options.timeoutMs ?? 0),
      });
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (isAbortError(error, options.signal)) {
        return;
      }
      disarmAbort();
      disarmDeadline();
      fail({
        errno: error.code,
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
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
        fail(
          {
            errno: "ABORT_ERR",
            stdout: stdoutChunks.join(""),
            stderr: stderrChunks.join(""),
            message: abortMessage(args),
          },
          false,
        );
        return;
      }
      if (code !== 0 && code !== null) {
        fail({
          code,
          stdout: stdoutChunks.join(""),
          stderr: stderrChunks.join(""),
          message: `vercel ${args.join(" ")} exited with code ${code}.`,
        });
        return;
      }
      succeed();
    });
  });
}
