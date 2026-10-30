import { spawn, spawnSync, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import { request as requestHttp, type Agent } from "node:http";
import { existsSync, watch as watchFileSystem } from "node:fs";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";

import {
  EVE_DEV_RUNTIME_ARTIFACTS_REBUILD_ROUTE_PATH,
  EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH,
  EVE_INFO_ROUTE_PATH,
} from "../../src/protocol/routes.js";
import type { AgentInfoResponse } from "../../src/internal/nitro/routes/agent-info/build-agent-info-response.js";

/**
 * Handle to a spawned `eve dev --no-ui` process serving a scenario app.
 */
export interface RunningEveDev {
  crash(): Promise<void>;
  readonly stderr: () => string;
  readonly stdout: () => string;
  readonly url: string;
  signalAndAwaitExit(
    signal: NodeJS.Signals,
    deadlineMs?: number,
  ): Promise<{
    readonly code: number | null;
    readonly durationMs: number;
    readonly forcedKill: boolean;
    readonly signal: NodeJS.Signals | null;
  }>;
  stop(): Promise<void>;
}

export interface StartEveDevOptions {
  readonly defaultExtensions?: boolean;
  readonly resume?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** `bun` launches the Node bin with the environment `bunx` sets, so eve hands off to Bun. */
  readonly runtime?: "bun" | "node";
}

export async function signalEveDevDuringStartup(
  appRoot: string,
  signal: NodeJS.Signals,
): Promise<{ readonly durationMs: number; readonly forcedKill: boolean }> {
  const child = spawnEveDev(appRoot, {});
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    output += chunk;
  });
  const deadline = Date.now() + 30_000;
  while (!output.includes("eve")) {
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for eve dev startup.\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  const startedAt = Date.now();
  let forcedKill = false;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      forcedKill = true;
      child.kill("SIGKILL");
    }, 1_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill(signal);
  });
  return { durationMs: Date.now() - startedAt, forcedKill };
}

/**
 * Spawns `eve dev --no-ui` for the app and resolves once the server URL is
 * printed and the state record exists. `NODE_ENV=test` activates the
 * deterministic mock-model adapter so streamed turns complete without model
 * credentials.
 */
export async function startEveDev(
  appRoot: string,
  options: StartEveDevOptions = {},
): Promise<RunningEveDev> {
  const child = spawnEveDev(appRoot, options);
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
    url = await waitForServerUrl({
      child,
      getOutput: () => ({ stderr, stdout }),
    });
    await waitForPath(join(appRoot, ".eve", "dev-server-state.v1.json"));
  } catch (error) {
    await stopChildProcess(child);
    throw error;
  }

  return {
    async crash() {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      await withinDeadline(
        new Promise<void>((resolve) => {
          child.once("exit", () => resolve());
          child.kill("SIGKILL");
        }),
        "Timed out waiting for the dev server process to crash.",
      );
    },
    stderr: () => stderr,
    stdout: () => stdout,
    async signalAndAwaitExit(signal, deadlineMs = 1_000) {
      if (child.exitCode !== null || child.signalCode !== null) {
        return { code: child.exitCode, durationMs: 0, forcedKill: false, signal: child.signalCode };
      }
      const startedAt = Date.now();
      return await new Promise((resolve) => {
        let forcedKill = false;
        const timer = setTimeout(() => {
          forcedKill = true;
          child.kill("SIGKILL");
        }, deadlineMs);
        child.once("exit", (code, exitSignal) => {
          clearTimeout(timer);
          resolve({ code, durationMs: Date.now() - startedAt, forcedKill, signal: exitSignal });
        });
        child.kill(signal);
      });
    },
    async stop() {
      await stopChildProcess(child);
    },
    url,
  };
}

export async function stopChildProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const forceTimeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
    const finalTimeout = setTimeout(settle, 15_000);

    function settle() {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(forceTimeout);
      clearTimeout(finalTimeout);
      child.off("exit", settle);
      resolve();
    }

    child.once("exit", settle);
    child.kill("SIGTERM");
  });
}

function spawnEveDev(
  appRoot: string,
  options: StartEveDevOptions,
): ChildProcessByStdio<null, Readable, Readable> {
  const eveBinPath = join(appRoot, "node_modules", "eve", "bin", "eve.js");
  const args = [eveBinPath, "dev", "--no-ui", "--host", "127.0.0.1", "--port", "0"];
  if (options.defaultExtensions === false) args.push("--no-default-extensions");
  if (options.resume) args.push("--resume");

  return spawn(process.execPath, args, {
    cwd: appRoot,
    env: {
      ...process.env,
      NODE_ENV: "test",
      ...(options.runtime === "bun" && bunLauncherEnvironment()),
      ...options.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** The environment `bunx` gives a bin whose Node shebang it honors. */
function bunLauncherEnvironment(): Record<string, string> {
  const bunExecutable = resolveBunExecutable();
  if (bunExecutable === undefined) throw new Error("Bun is not installed.");
  return { npm_config_user_agent: "bun/scenario", npm_execpath: bunExecutable };
}

/** Absolute path of the `bun` binary on `PATH`, if any. */
export function resolveBunExecutable(): string | undefined {
  try {
    const result = spawnSync("bun", ["-e", "process.stdout.write(process.execPath)"], {
      encoding: "utf8",
    });
    return result.status === 0 && result.stdout.length > 0 ? result.stdout : undefined;
  } catch {
    return undefined;
  }
}

export async function waitForWebSocketOpen(socket: WebSocket): Promise<void> {
  await waitForWebSocketEvent(socket, "open", () => undefined);
}

export async function waitForWebSocketMessage(socket: WebSocket): Promise<string> {
  return await waitForWebSocketEvent(socket, "message", (event) => String(event.data));
}

export async function waitForWebSocketClose(socket: WebSocket): Promise<void> {
  await waitForWebSocketEvent(socket, "close", () => undefined);
}

async function waitForWebSocketEvent<T>(
  socket: WebSocket,
  eventName: "close" | "message" | "open",
  select: (event: MessageEvent) => T,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const deadline = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for WebSocket ${eventName}.`));
    }, 10_000);
    const cleanup = () => {
      clearTimeout(deadline);
      socket.removeEventListener(eventName, onEvent);
      socket.removeEventListener("error", onError);
    };
    const onEvent = (event: Event) => {
      cleanup();
      resolve(select(event as MessageEvent));
    };
    const onError = () => {
      cleanup();
      reject(new Error(`WebSocket failed while waiting for ${eventName}.`));
    };
    socket.addEventListener(eventName, onEvent, { once: true });
    socket.addEventListener("error", onError, { once: true });
  });
}

export function hasUnsupportedWindowsEsmImport(text: string): boolean {
  return (
    text.includes("ERR_UNSUPPORTED_ESM_URL_SCHEME") ||
    text.includes("Received protocol 'g:'") ||
    text.includes('Received protocol "g:"')
  );
}

/**
 * Matches output signatures that mean the dev server broke: reset sockets,
 * unresolved generated imports, or a pruned module-map loader.
 */
export function hasKnownDevServerFailure(text: string): boolean {
  return (
    hasUnsupportedWindowsEsmImport(text) ||
    text.includes("UNRESOLVED_IMPORT") ||
    text.includes("ECONNRESET") ||
    text.includes("socket hang up") ||
    text.includes("UnhandledPromiseRejection") ||
    text.includes("ERR_UNHANDLED_REJECTION") ||
    text.includes("dev worker restart failed") ||
    (text.includes("ERR_MODULE_NOT_FOUND") && text.includes("authored-module-map-loader"))
  );
}

export async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  failureMessage: string | (() => string),
  timeoutMs: number = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!(await condition())) {
    if (Date.now() >= deadline) {
      throw new Error(typeof failureMessage === "function" ? failureMessage() : failureMessage);
    }
    await wait(100);
  }
}

export async function withinDeadline<T>(
  operation: Promise<T>,
  failureMessage: string,
  timeoutMs: number = 60_000,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(failureMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

export async function waitForPath(path: string, timeoutMs: number = 60_000): Promise<void> {
  if (existsSync(path)) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const watcher = watchFileSystem(dirname(path), () => {
      if (existsSync(path)) {
        settle(resolve);
      }
    });
    const timeout = setTimeout(() => {
      settle(() => reject(new Error(`Timed out waiting for ${path}.`)));
    }, timeoutMs);
    function settle(complete: () => void) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      watcher.close();
      complete();
    }
    if (existsSync(path)) {
      settle(resolve);
    }
  });
}

export async function fetchText(serverUrl: string, path: string): Promise<string> {
  const response = await fetch(new URL(path, serverUrl));
  if (!response.ok) {
    throw new Error(`Expected ${path} to succeed, received ${String(response.status)}.`);
  }
  return await response.text();
}

export async function fetchAgentInfo(serverUrl: string): Promise<AgentInfoResponse> {
  const response = await fetch(new URL(EVE_INFO_ROUTE_PATH, serverUrl));
  if (!response.ok) {
    throw new Error(`Expected agent info to succeed, received ${String(response.status)}.`);
  }
  return (await response.json()) as AgentInfoResponse;
}

export async function forceDevelopmentRebuild(serverUrl: string, agent?: Agent): Promise<void> {
  const rebuildUrl = new URL(EVE_DEV_RUNTIME_ARTIFACTS_REBUILD_ROUTE_PATH, serverUrl);
  rebuildUrl.searchParams.set("force", "1");
  if (agent !== undefined) {
    const response = await requestWithAgent(rebuildUrl.href, agent);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`Development rebuild failed with status ${String(response.statusCode)}.`);
    }
    return;
  }
  const response = await fetch(rebuildUrl);
  if (!response.ok) {
    throw new Error(`Development rebuild failed with status ${String(response.status)}.`);
  }
}

export async function readDevelopmentRevision(serverUrl: string): Promise<string> {
  const response = await fetch(new URL(EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH, serverUrl));
  if (!response.ok) {
    throw new Error(`Development runtime state failed with status ${String(response.status)}.`);
  }
  const body = (await response.json()) as { readonly revision?: unknown };
  if (typeof body.revision !== "string") {
    throw new Error("Development runtime state did not include a revision.");
  }
  return body.revision;
}

function stripAnsi(text: string): string {
  return text
    .split("\u001b[")
    .map((segment, index) => {
      if (index === 0) {
        return segment;
      }

      return segment.replace(/^[0-9;]*m/, "");
    })
    .join("");
}

function parseServerUrl(stdout: string): string | undefined {
  const match = /server listening at (https?:\/\/\S+)/.exec(stripAnsi(stdout));

  return match?.[1];
}

async function waitForServerUrl(input: {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly getOutput: () => {
    readonly stderr: string;
    readonly stdout: string;
  };
}): Promise<string> {
  return await new Promise((resolve, reject) => {
    let settled = false;

    const timeout = setTimeout(() => {
      settleReject(
        new Error(
          [
            "Timed out waiting for eve dev to print its server URL.",
            `stdout:\n${input.getOutput().stdout}`,
            `stderr:\n${input.getOutput().stderr}`,
          ].join("\n\n"),
        ),
      );
    }, 120_000);

    const cleanup = () => {
      clearTimeout(timeout);
      input.child.stdout.off("data", handleOutput);
      input.child.stderr.off("data", handleOutput);
      input.child.off("error", settleReject);
      input.child.off("exit", handleExit);
    };

    const settleResolve = (url: string) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve(url);
    };

    function settleReject(error: unknown) {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    }

    function handleOutput() {
      const output = input.getOutput();
      const combinedOutput = `${output.stdout}\n${output.stderr}`;

      if (hasKnownDevServerFailure(combinedOutput)) {
        settleReject(
          new Error(
            [
              "eve dev emitted a known reload or generated-bundle failure.",
              `stdout:\n${output.stdout}`,
              `stderr:\n${output.stderr}`,
            ].join("\n\n"),
          ),
        );
        return;
      }

      const url = parseServerUrl(output.stdout);

      if (url !== undefined) {
        settleResolve(url);
      }
    }

    function handleExit(code: number | null, signal: NodeJS.Signals | null) {
      const output = input.getOutput();

      settleReject(
        new Error(
          [
            `eve dev exited before printing its server URL (code ${String(code)}, signal ${String(signal)}).`,
            `stdout:\n${output.stdout}`,
            `stderr:\n${output.stderr}`,
          ].join("\n\n"),
        ),
      );
    }

    input.child.stdout.on("data", handleOutput);
    input.child.stderr.on("data", handleOutput);
    input.child.once("error", settleReject);
    input.child.once("exit", handleExit);
    handleOutput();
  });
}

/**
 * Issues one GET through the provided keep-alive agent and reports the local
 * port so callers can assert connection reuse across worker replacements.
 */
export async function requestWithAgent(
  url: string,
  agent: Agent,
): Promise<{
  readonly body: string;
  readonly localPort: number | undefined;
  readonly statusCode: number;
}> {
  return await new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = requestHttp(
      {
        agent,
        host: target.hostname,
        path: `${target.pathname}${target.search}`,
        port: Number(target.port),
      },
      (response) => {
        const chunks: Buffer[] = [];
        const localPort = response.socket.localPort;
        const statusCode = response.statusCode ?? 0;
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({ body: Buffer.concat(chunks).toString("utf8"), localPort, statusCode });
        });
      },
    );
    request.once("error", reject);
    request.end();
  });
}
