import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { loadDevelopmentEnvironmentFiles } from "#cli/dev/environment.js";
import { prewarmBuiltAppSandboxes } from "#execution/sandbox/prewarm.js";
import { isProductionServerMessage } from "#internal/nitro/host/production-server-process.js";
import type { ProductionServerHandle } from "#internal/nitro/host/types.js";

const DEFAULT_PRODUCTION_SERVER_HOST = "0.0.0.0";
const DEFAULT_PRODUCTION_SERVER_PORT = 3000;
const READY_TIMEOUT_MS = 60_000;
// Must exceed the server's bounded sandbox shutdown (15s in
// sandbox-shutdown-plugin.ts) so stopping sandboxes on SIGTERM is not
// cut short by SIGKILL.
const TERMINATE_GRACE_MS = 20_000;
const WILDCARD_LISTEN_HOSTNAMES: ReadonlySet<string> = new Set(["[::]", "::", "0.0.0.0"]);

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

function formatClientHost(host: string): string {
  if (WILDCARD_LISTEN_HOSTNAMES.has(host)) {
    return "127.0.0.1";
  }

  if (host.includes(":") && !host.startsWith("[")) {
    return `[${host}]`;
  }

  return host;
}

function createKnownPortUrl(input: { host: string; port: number }): string {
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

function waitForReady(child: ChildProcess): Promise<void> {
  return new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      cleanup();
      rejectReady(
        new Error(`Built server did not become ready within ${READY_TIMEOUT_MS / 1000}s.`),
      );
    }, READY_TIMEOUT_MS);

    const onMessage = (message: unknown) => {
      if (!isProductionServerMessage(message)) return;
      if (message.type === "eve:production-server:error") {
        cleanup();
        rejectReady(new Error(`Built server failed to start: ${message.message}`));
        return;
      }
      cleanup();
      resolveReady();
    };
    const onError = (error: Error) => {
      cleanup();
      rejectReady(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      rejectReady(
        new Error(
          `Built server process exited (code=${String(code)}, signal=${String(signal)}) before becoming ready.`,
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
    };

    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });
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
  const url = createKnownPortUrl({
    host,
    port,
  });
  let output = "";
  let closing = false;
  const childModulePath = new URL("./production-server-child.js", import.meta.url);
  const child = fork(childModulePath, [JSON.stringify({ serverEntry, url })], {
    cwd: appRoot,
    env: {
      ...process.env,
      HOST: host,
      NITRO_HOST: host,
      NITRO_PORT: String(port),
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
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
    await waitForReady(child);

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

    throw error;
  }
}
