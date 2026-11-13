import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const EVE_BIN_PATH = fileURLToPath(new URL("../../bin/eve.js", import.meta.url));

export interface RunningEveStart {
  readonly url: string;
  /** SIGKILLs `eve start` and its server child at once, as a lost host would. */
  crash(): Promise<void>;
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
      // Its own process group, so `crash()` reaches the server child too.
      detached: true,
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
    async crash() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      process.kill(-child.pid!, "SIGKILL");
      await exited;
    },
    stderr: () => stderr,
    stdout: () => stdout,
    async stop() {
      await stopChildProcess(child, () => stderr);
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

// srvx prints this once the server and Nitro's close hooks are done.
const SERVER_CLOSED_LINE = "Server closed successfully.";

/**
 * Sends SIGTERM and waits for the server to close. Once it has, the group is
 * killed: after a session ran, the built server does not exit on its own, and
 * `eve start` would only SIGKILL it after its 25s grace.
 */
async function stopChildProcess(child: ChildProcess, readStderr?: () => string): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  const stderrBefore = readStderr?.().length ?? 0;
  const closed = () => readStderr?.().slice(stderrBefore).includes(SERVER_CLOSED_LINE) === true;
  await new Promise<void>((resolve) => {
    const killGroup = () => {
      clearInterval(poll);
      clearTimeout(timeout);
      // The whole group, so a server child that outlives `eve start` dies too.
      process.kill(-child.pid!, "SIGKILL");
    };
    const poll = setInterval(() => {
      if (closed()) killGroup();
    }, 50);
    const timeout = setTimeout(() => {
      killGroup();
      resolve();
    }, 10_000);

    child.once("exit", () => {
      clearInterval(poll);
      clearTimeout(timeout);
      resolve();
    });
    child.kill("SIGTERM");
  });
}
