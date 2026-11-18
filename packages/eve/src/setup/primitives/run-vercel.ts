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
  return { ...withoutCodingAgentMarkers(process.env), ...CONNECT_FEATURE_FLAG_ENV, ...extraEnv };
}

function commandArgs(args: string[], nonInteractive: boolean | undefined): string[] {
  if (!nonInteractive || args.includes("--non-interactive")) return args;
  return [...args, "--non-interactive"];
}

function existingDir(dir: string): string {
  let current = resolve(dir);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

export interface RunVercelOptions {
  cwd: string;
  extraEnv?: Readonly<Record<string, string>>;
  nonInteractive?: boolean;
  stdin?: string;
  onOutput?: ProcessOutputHandler;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const KILL_GRACE_MS = 5_000;

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

type VercelStdio = "inherit" | [StdioChannel, StdioChannel, StdioChannel];

interface VercelRunFailure {
  code?: number | null;
  errno?: string;
  message: string;
}

type VercelRunOutcome =
  | { ok: true; stdout: string; stderr: string }
  | ({ ok: false; stdout: string; stderr: string } & VercelRunFailure);

interface VercelRunSpec<T> {
  stdio: VercelStdio;
  capture: boolean;
  reportWithoutRenderer: boolean;
  result(outcome: VercelRunOutcome): T;
}

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

export async function runVercel(args: string[], options: RunVercelOptions): Promise<boolean> {
  return runVercelProcess(args, options, {
    stdio: stdioForRun(options),
    capture: false,
    reportWithoutRenderer: true,
    result: (outcome) => outcome.ok,
  });
}

export interface RunVercelCaptureResult {
  ok: boolean;
  stdout: string;
  stderr?: string;
}

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

export interface VercelCaptureFailure {
  code?: number | null;
  errno?: string;
  stderr: string;
  stdout: string;
  message: string;
}

export type VercelCaptureResult =
  | { ok: true; stdout: string }
  | { ok: false; failure: VercelCaptureFailure };

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
