import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { resolvePnpmInvocation } from "#internal/process/pnpm.js";

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
