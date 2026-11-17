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

interface PnpmCommandResult {
  readonly stderr: string;
  readonly stdout: string;
}

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

interface PnpmInvocation {
  readonly args: readonly string[];
  readonly command: string;
  readonly shell?: boolean;
}

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
