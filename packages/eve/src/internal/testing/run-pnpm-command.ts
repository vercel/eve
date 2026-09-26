import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import { promisify } from "node:util";

const runFile = promisify(execFile);

interface PnpmCommandInput {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Captured stdout/stderr from one pnpm invocation.
 *
 * Callers that just want to ensure success can ignore the result; callers
 * that need to parse output (e.g. `pnpm dlx vercel deploy --json`) read
 * `stdout` directly.
 */
export interface PnpmCommandResult {
  readonly stderr: string;
  readonly stdout: string;
}

/**
 * Runs pnpm from scenario, e2e, and setup helpers.
 *
 * Windows GitHub runners expose pnpm through `PNPM_HOME` for shell commands,
 * but child processes spawned by Vitest setup do not always inherit a PATH
 * that can resolve the bare `pnpm` command. {@link resolvePnpmInvocation}
 * picks the right executable for the current OS and execution environment
 * so callers do not have to special-case Windows or Corepack-shimmed paths.
 *
 * Returns the captured stdout/stderr so callers that need to parse output
 * (e.g. `pnpm dlx vercel deploy --json`) do not have to reach for `execFile`
 * directly and re-implement the platform handling.
 */
export async function runPnpmCommand(input: PnpmCommandInput): Promise<PnpmCommandResult> {
  const invocation = resolvePnpmInvocation(input.args);

  try {
    const result = await runFile(invocation.command, [...invocation.args], {
      cwd: input.cwd,
      env: input.env,
      maxBuffer: 10 * 1024 * 1024,
      shell: invocation.shell,
    });

    return {
      stderr: result.stderr,
      stdout: result.stdout,
    };
  } catch (error) {
    const failure = error as {
      readonly stderr?: unknown;
      readonly stdout?: unknown;
    };
    const stdout = typeof failure.stdout === "string" ? failure.stdout : "";
    const stderr = typeof failure.stderr === "string" ? failure.stderr : "";

    throw new Error(
      [
        `Command failed: pnpm ${input.args.join(" ")}`,
        `cwd: ${input.cwd}`,
        `stdout:\n${stdout}`,
        `stderr:\n${stderr}`,
      ].join("\n\n"),
      {
        cause: error,
      },
    );
  }
}

/**
 * Resolved invocation for the host's pnpm executable. The shape carries
 * everything `child_process.spawn` and `execFile` need to dispatch to the
 * right binary across macOS/Linux PATH installs, Corepack-managed shims,
 * and Windows runners that surface pnpm only through `PNPM_HOME`.
 */
interface PnpmInvocation {
  readonly args: readonly string[];
  readonly command: string;
  readonly shell?: boolean;
}

/**
 * Picks the right pnpm executable for the current host. Resolution order:
 *
 *  1. `PNPM_HOME` — the standard install location used by Corepack and the
 *     pnpm installers. On Windows, points at `pnpm.CMD` because the bare
 *     `pnpm` shim is not directly invokable from a non-shell spawn.
 *  2. `npm_execpath` — set when the current process was launched by an
 *     npm-compatible package manager. Pointing at a `.cjs`/`.js` entry
 *     means we have to run it through `node` (typical for Corepack
 *     shims); otherwise treat it as a bare executable path.
 *  3. Bare `pnpm` on PATH — the macOS/Linux happy path.
 *
 * Pure: no side effects, returns the invocation shape.
 */
function resolvePnpmInvocation(args: readonly string[]): PnpmInvocation {
  const pnpmHome = process.env.PNPM_HOME;

  if (pnpmHome !== undefined) {
    const command = join(pnpmHome, process.platform === "win32" ? "pnpm.CMD" : "pnpm");

    if (existsSync(command)) {
      return {
        args,
        command,
        shell: process.platform === "win32",
      };
    }
  }

  const npmExecPath = process.env.npm_execpath;

  if (npmExecPath !== undefined && npmExecPath.toLowerCase().includes("pnpm")) {
    const extension = extname(npmExecPath).toLowerCase();

    if (extension === ".cjs" || extension === ".js") {
      return {
        args: [npmExecPath, ...args],
        command: process.execPath,
      };
    }

    return {
      args,
      command: npmExecPath,
      shell: process.platform === "win32",
    };
  }

  return {
    args,
    command: "pnpm",
  };
}
