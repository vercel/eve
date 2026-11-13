import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { expect } from "vitest";

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

/** Well under `eve start`'s 25s SIGKILL grace, which a server that hangs on exit would reach. */
const STOP_TIMEOUT_MS = 10_000;

/**
 * Sends SIGTERM and waits for `eve start` to exit on its own, as it does once its server has
 * closed. A process that outlives the timeout fails the test, after its group is killed. In a
 * test that fails as a soft assertion, so a `finally` that stops the server keeps the test's own
 * error; outside one, in a hook, it throws.
 */
async function stopChildProcess(child: ChildProcess, readStderr?: () => string): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  let timer: NodeJS.Timeout | undefined;
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), STOP_TIMEOUT_MS))),
  ]);
  clearTimeout(timer);
  if (stopped) return;

  // The whole group, so a server child that outlives `eve start` dies too.
  process.kill(-child.pid!, "SIGKILL");
  await exited;
  const message = `eve start did not exit within ${STOP_TIMEOUT_MS / 1000}s of SIGTERM.\n\nstderr:\n${readStderr?.() ?? ""}`;
  if (expect.getState().currentTestName === undefined) throw new Error(message);
  expect.soft(stopped, message).toBe(true);
}
