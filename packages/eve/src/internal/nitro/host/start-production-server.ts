import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { loadDevelopmentEnvironmentFiles } from "#cli/dev/environment.js";
import { prewarmBuiltAppSandboxes } from "#execution/sandbox/prewarm.js";
import { EVE_HEALTH_ROUTE_PATH } from "#protocol/routes.js";
import type { ProductionServerHandle } from "#internal/nitro/host/types.js";

const DEFAULT_PRODUCTION_SERVER_HOST = "0.0.0.0";
const DEFAULT_PRODUCTION_SERVER_PORT = 3000;
const HEALTH_POLL_INTERVAL_MS = 250;
const HEALTH_TIMEOUT_MS = 60_000;
const LOCAL_SERVER_URL_PATTERN = /https?:\/\/(?:\[[^\]\s]+\]|[^\s/:[\]]+)(?::\d+)?/;
const TERMINATE_GRACE_MS = 5_000;
const WILDCARD_LISTEN_HOSTNAMES: ReadonlySet<string> = new Set(["[::]", "::", "0.0.0.0"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAddressInUseError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EADDRINUSE";
}

function resolveOutputServerEntry(appRoot: string): string {
  return join(resolve(appRoot), ".output", "server", "index.mjs");
}

function readEnvironmentPort(): number | undefined {
  const raw = process.env.PORT;

  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }

  const parsed = Number(raw);

  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(
      `Invalid PORT environment variable "${raw}". Expected an integer between 0 and 65535.`,
    );
  }

  return parsed;
}

function normalizeServerClientUrl(serverUrl: string): string {
  const url = new URL(serverUrl);

  if (WILDCARD_LISTEN_HOSTNAMES.has(url.hostname)) {
    url.hostname = "127.0.0.1";
  }

  return url.toString();
}

function formatClientHost(host: string): string {
  if (WILDCARD_LISTEN_HOSTNAMES.has(host)) {
    return "127.0.0.1";
  }

  if (host.includes(":") && !host.startsWith("[")) {
    return `[${host}]`;
  }

  return host;
}

function createKnownPortUrl(input: { host: string; port: number }): string | undefined {
  return `http://${formatClientHost(input.host)}:${String(input.port)}/`;
}

async function resolveListenPort(input: { host: string; port: number }): Promise<number> {
  if (input.port !== 0) {
    return input.port;
  }

  const server = createServer();

  return await new Promise((resolvePort, rejectPort) => {
    server.once("error", rejectPort);
    server.listen(0, input.host, () => {
      const address = server.address();

      server.close((error) => {
        if (error) {
          rejectPort(error);
          return;
        }

        if (address === null || typeof address === "string") {
          rejectPort(new Error("Failed to resolve an available port for eve start."));
          return;
        }

        resolvePort(address.port);
      });
    });
  });
}

function parseServerUrlFromOutput(output: string): string | undefined {
  const match = LOCAL_SERVER_URL_PATTERN.exec(output);

  if (match === null) {
    return undefined;
  }

  return normalizeServerClientUrl(match[0]);
}

async function waitForHealth(input: {
  child: ChildProcess;
  getStartError(): unknown;
  url: string;
}): Promise<string> {
  const { child, url } = input;
  const healthUrl = new URL(EVE_HEALTH_ROUTE_PATH, url).toString();
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const startError = input.getStartError();
    if (startError !== undefined) {
      throw startError;
    }

    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Built server process exited (code=${String(child.exitCode)}, signal=${String(child.signalCode)}) before becoming healthy.`,
      );
    }

    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return new URL(url).toString();
    } catch (error) {
      if (isAddressInUseError(error)) {
        throw error;
      }
    }

    await sleep(HEALTH_POLL_INTERVAL_MS);
  }

  throw new Error(
    `Built server did not become healthy within ${HEALTH_TIMEOUT_MS / 1000}s at ${healthUrl}.`,
  );
}

async function waitForReady(input: {
  child: ChildProcess;
  getStartError(): unknown;
  getOutput(): string;
  knownUrl?: string;
}): Promise<string> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const startError = input.getStartError();
    if (startError !== undefined) {
      throw startError;
    }

    const parsedUrl = parseServerUrlFromOutput(input.getOutput());
    const url = parsedUrl ?? input.knownUrl;

    if (url !== undefined) {
      return await waitForHealth({
        child: input.child,
        getStartError: input.getStartError,
        url,
      });
    }

    if (input.child.exitCode !== null || input.child.signalCode !== null) {
      throw new Error(
        `Built server process exited (code=${String(input.child.exitCode)}, signal=${String(input.child.signalCode)}) before printing its URL.`,
      );
    }

    await sleep(HEALTH_POLL_INTERVAL_MS);
  }

  throw new Error(
    [
      `Built server did not become ready within ${HEALTH_TIMEOUT_MS / 1000}s.`,
      `Output:`,
      input.getOutput(),
    ].join("\n"),
  );
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return;

  child.kill("SIGTERM");

  const exited = await Promise.race([
    once(child, "exit"),
    sleep(TERMINATE_GRACE_MS).then(() => "timeout" as const),
  ]);

  if (exited === "timeout" && child.exitCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }

  child.stdout?.destroy();
  child.stderr?.destroy();
}

function once(child: ChildProcess, event: "exit"): Promise<void> {
  return new Promise((resolvePromise) => {
    child.once(event, () => resolvePromise());
  });
}

/**
 * Starts a built Nitro server for an eve application.
 */
export async function startProductionServer(
  rootDir: string,
  options: {
    host?: string;
    port?: number;
  } = {},
): Promise<ProductionServerHandle> {
  const appRoot = resolve(rootDir);
  const serverEntry = resolveOutputServerEntry(appRoot);

  if (!existsSync(serverEntry)) {
    throw new Error(
      `Missing eve build output at ${serverEntry}. Run "eve build" before "eve start".`,
    );
  }

  loadDevelopmentEnvironmentFiles(appRoot);
  await prewarmBuiltAppSandboxes({
    appRoot,
    log: (message) => console.log(message),
  });

  const host = options.host ?? DEFAULT_PRODUCTION_SERVER_HOST;
  const port = await resolveListenPort({
    host,
    port: options.port ?? readEnvironmentPort() ?? DEFAULT_PRODUCTION_SERVER_PORT,
  });
  const knownUrl = createKnownPortUrl({
    host,
    port,
  });
  let output = "";
  let closing = false;
  let startError: unknown;

  const child = spawn(process.execPath, [serverEntry], {
    cwd: appRoot,
    env: {
      ...process.env,
      HOST: host,
      NITRO_HOST: host,
      NITRO_PORT: String(port),
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
    process.stdout.write(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
    process.stderr.write(chunk);
  });

  const wait = new Promise<void>((resolveWait, rejectWait) => {
    child.once("error", (error) => {
      startError = error;
      rejectWait(error);
    });
    child.once("exit", (code, signal) => {
      if (closing || code === 0) {
        resolveWait();
        return;
      }

      rejectWait(
        new Error(
          [
            `Built server process exited unexpectedly (code=${String(code)}, signal=${String(signal)}).`,
            output,
          ].join("\n"),
        ),
      );
    });
  });
  void wait.catch(() => undefined);

  try {
    const url = await waitForReady({
      child,
      getStartError: () => startError,
      getOutput: () => output,
      knownUrl,
    });

    return {
      async close() {
        closing = true;
        await terminate(child);
      },
      url,
      async wait() {
        await wait;
      },
    };
  } catch (error) {
    closing = true;
    await terminate(child);

    if (isRecord(error) && error.name === "AbortError") {
      throw new Error("Timed out waiting for built eve server to respond.", { cause: error });
    }

    throw error;
  }
}
