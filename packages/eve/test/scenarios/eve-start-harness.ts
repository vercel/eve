import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const EVE_BIN_PATH = fileURLToPath(new URL("../../bin/eve.js", import.meta.url));

export interface RunningEveStart {
  readonly url: string;
  stderr(): string;
  stdout(): string;
  stop(): Promise<void>;
}

/** Runs the packaged `eve start` for a built app on an available local port. */
export async function startPackagedEveStart(appRoot: string): Promise<RunningEveStart> {
  const child = spawn(
    process.execPath,
    [EVE_BIN_PATH, "start", "--host", "127.0.0.1", "--port", "0"],
    {
      cwd: appRoot,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  let stdout = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  let url: string;
  try {
    url = await waitForStartUrl({
      child,
      getOutput: () => ({
        stderr,
        stdout,
      }),
    });
  } catch (error) {
    await stopChildProcess(child);
    throw error;
  }

  return {
    stderr: () => stderr,
    stdout: () => stdout,
    async stop() {
      await stopChildProcess(child);
    },
    url,
  };
}

async function waitForStartUrl(input: {
  readonly child: ChildProcess;
  readonly getOutput: () => {
    readonly stderr: string;
    readonly stdout: string;
  };
}): Promise<string> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 60_000) {
    const output = input.getOutput();
    const url = parseStartUrl(output.stdout);

    if (url !== undefined) {
      return url;
    }

    if (input.child.exitCode !== null || input.child.signalCode !== null) {
      throw new Error(
        [
          `eve start exited before printing its server URL (code ${String(
            input.child.exitCode,
          )}, signal ${String(input.child.signalCode)}).`,
          `stdout:\n${output.stdout}`,
          `stderr:\n${output.stderr}`,
        ].join("\n\n"),
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const output = input.getOutput();
  throw new Error(
    [
      "Timed out waiting for eve start to print its server URL.",
      `stdout:\n${output.stdout}`,
      `stderr:\n${output.stderr}`,
    ].join("\n\n"),
  );
}

function parseStartUrl(output: string): string | undefined {
  const match = /\[START\] server listening at (https?:\/\/[^\s]+)/.exec(output);
  return match?.[1];
}

async function stopChildProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 10_000);

    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill("SIGTERM");
  });
}
