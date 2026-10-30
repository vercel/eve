import { spawn, type ChildProcessByStdio } from "node:child_process";
import { join } from "node:path";
import type { Readable } from "node:stream";

/** How long `eve dev` gets to report the URL it listens at. */
const STARTUP_TIMEOUT_MS = 30_000;

/** An `eve dev` server a scenario test started, with its output so far. */
export interface RunningEveDev {
  readonly stderr: () => string;
  readonly stdout: () => string;
  readonly url: string;
  stop(): Promise<void>;
}

/**
 * Starts the scenario app's own `eve dev` on a free loopback port, as a production build with its
 * authored models (a scenario's `mockModel`), and resolves once it reports its URL.
 */
export async function startScenarioEveDev(appRoot: string): Promise<RunningEveDev> {
  const eveBinPath = join(appRoot, "node_modules", "eve", "bin", "eve.js");
  const child = spawn(
    process.execPath,
    [eveBinPath, "dev", "--no-ui", "--host", "127.0.0.1", "--port", "0"],
    {
      cwd: appRoot,
      env: { ...process.env, EVE_MOCK_AUTHORED_MODELS: "", NODE_ENV: "production" },
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
    url = await waitForServerUrl(child, () => ({ stderr, stdout }));
  } catch (error) {
    await stopChild(child);
    throw error;
  }
  return {
    stderr: () => stderr,
    stdout: () => stdout,
    async stop() {
      await stopChild(child);
    },
    url,
  };
}

/** `value` as a plain object, or a thrown error naming what it should have been. */
export function requiredRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} was not an object.`);
  }
  return value as Record<string, unknown>;
}

/** `value` as a non-empty string, or a thrown error naming what it should have been. */
export function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} was not a non-empty string.`);
  }
  return value;
}

async function waitForServerUrl(
  child: ChildProcessByStdio<null, Readable, Readable>,
  output: () => { readonly stderr: string; readonly stdout: string },
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const failed = (reason: string) => {
      const current = output();
      return new Error(`${reason}\n${current.stdout}\n${current.stderr}`);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(failed("Timed out waiting for eve dev."));
    }, STARTUP_TIMEOUT_MS);
    function inspect() {
      const url = /\[DEV\] server listening at (http:\/\/[^\s]+)/u.exec(output().stdout)?.[1];
      if (url !== undefined) {
        cleanup();
        resolve(url);
      }
    }
    function exited(code: number | null, signal: NodeJS.Signals | null) {
      cleanup();
      reject(failed(`eve dev exited before startup (code ${String(code)}, ${String(signal)}).`));
    }
    function cleanup() {
      clearTimeout(timeout);
      child.stdout.off("data", inspect);
      child.stderr.off("data", inspect);
      child.off("exit", exited);
    }
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("exit", exited);
    inspect();
  });
}

async function stopChild(child: ChildProcessByStdio<null, Readable, Readable>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const force = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
    child.kill("SIGTERM");
  });
}
