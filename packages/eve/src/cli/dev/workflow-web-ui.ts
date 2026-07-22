import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";

import { resolveLocalWorkflowWorldDataDirectory } from "#internal/workflow/local-world-data-directory.js";

const WORKFLOW_CLI_VERSION = "5.0.0-beta.35";
const STARTUP_TIMEOUT_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

/** A running Workflow SDK observability UI owned by `eve dev`. */
export interface WorkflowWebUiHandle {
  readonly url: string;
  close(): Promise<void>;
}

/**
 * Starts the version-matched Workflow SDK Web UI against eve's local Workflow store.
 *
 * The UI runs in a child process so its Workflow global state cannot interfere with
 * the parent-owned local world that survives development worker rebuilds.
 */
export async function startWorkflowWebUi(input: {
  readonly appRoot: string;
  readonly agentServerUrl: string;
  readonly port: number;
}): Promise<WorkflowWebUiHandle> {
  const dataDir = resolveLocalWorkflowWorldDataDirectory(input.appRoot);
  await access(dataDir);

  const executable = process.platform === "win32" ? "npx.cmd" : "npx";
  const child = spawn(
    executable,
    [
      "--yes",
      `workflow@${WORKFLOW_CLI_VERSION}`,
      "web",
      "--backend",
      "local",
      "--noBrowser",
      "--webPort",
      String(input.port),
    ],
    {
      cwd: input.appRoot,
      env: {
        ...process.env,
        WORKFLOW_DISABLE_BROWSER_OPEN: "1",
        WORKFLOW_LOCAL_BASE_URL: new URL(input.agentServerUrl).origin,
        WORKFLOW_LOCAL_DATA_DIR: dataDir,
        WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS: "false",
        WORKFLOW_TARGET_WORLD: "local",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let output = "";
  let spawnError: Error | undefined;
  const collectOutput = (chunk: Buffer | string) => {
    output = `${output}${String(chunk)}`.slice(-8_000);
  };
  child.on("error", (error) => {
    spawnError = error;
  });
  child.stdout?.on("data", collectOutput);
  child.stderr?.on("data", collectOutput);

  const url = `http://localhost:${input.port}`;
  try {
    await waitUntilReady(
      child,
      url,
      () => output,
      () => spawnError,
    );
  } catch (error) {
    await stopChild(child);
    throw error;
  }

  return {
    url,
    close: async () => await stopChild(child),
  };
}

async function waitUntilReady(
  child: ChildProcess,
  url: string,
  readOutput: () => string,
  readSpawnError: () => Error | undefined,
): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const spawnError = readSpawnError();
    if (spawnError !== undefined) {
      throw new Error(formatStartupError(`could not launch: ${spawnError.message}`, readOutput()));
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      const outcome =
        child.exitCode !== null ? `code ${child.exitCode}` : `signal ${child.signalCode}`;
      throw new Error(formatStartupError(`exited with ${outcome}`, readOutput()));
    }
    try {
      const response = await fetch(url, {
        method: "HEAD",
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return;
    } catch {
      // The CLI may be downloading its pinned package or starting the server.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(formatStartupError("did not become ready within 60 seconds", readOutput()));
}

function formatStartupError(reason: string, output: string): string {
  const detail = output.trim();
  return detail.length === 0
    ? `Workflow SDK Web UI ${reason}.`
    : `Workflow SDK Web UI ${reason}.\n${detail}`;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  child.kill("SIGTERM");
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const timedOut = new Promise<"timeout">((resolve) => {
    setTimeout(() => resolve("timeout"), SHUTDOWN_TIMEOUT_MS);
  });
  if ((await Promise.race([closed, timedOut])) === "timeout") {
    child.kill("SIGKILL");
    await closed;
  }
}
