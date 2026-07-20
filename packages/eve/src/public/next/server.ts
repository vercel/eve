import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { resolvePackageRoot } from "#internal/application/package.js";
import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";

const EVE_BASE_URL_ENV = "EVE_BASE_URL";
const DEFAULT_SERVER_READY_TIMEOUT_MS = 180_000;
const DEV_SERVER_REGISTRY_TIMEOUT_MS = 180_000;
const DEV_SERVER_REGISTRY_POLL_MS = 100;
const DEV_SERVER_STALE_LOCK_MS = 30_000;
const EVE_CACHE_DIRECTORY_NAME = ".eve";
const EVE_NEXT_DEV_SERVER_FILE_NAME = "next-dev-server.json";
const EVE_NEXT_DEV_SERVER_LOCK_FILE_NAME = "next-dev-server.lock";
const ANSI_ESCAPE = String.fromCharCode(27);
const ANSI_ESCAPE_PATTERN = new RegExp(`${ANSI_ESCAPE}\\[[0-?]*[ -/]*[@-~]`, "g");
const SERVER_URL_CANDIDATE_PATTERN = /https?:\/\/[^\s"'<>]+/g;
const NEXT_PHASE_PRODUCTION_BUILD = "phase-production-build";

interface EveProcessHandle {
  readonly origin: string;
  readonly process?: ChildProcess;
}

interface EveNextGlobalState {
  readonly servers: Map<string, Promise<EveProcessHandle>>;
}

interface EveDevServerRegistry {
  readonly appRoot: string;
  readonly origin: string;
  readonly pid: number | null;
  readonly updatedAt: string;
}

const globalStateSymbol = Symbol.for("eve.next.state");

function getGlobalState(): EveNextGlobalState {
  const globalWithState = globalThis as typeof globalThis & {
    [globalStateSymbol]?: EveNextGlobalState;
  };

  globalWithState[globalStateSymbol] ??= {
    servers: new Map(),
  };

  return globalWithState[globalStateSymbol];
}

function joinRoutePrefix(prefix: string, path: string): string {
  return `${prefix.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function normalizeOrigin(origin: string): string {
  return new URL(origin).origin;
}

function readEveBaseUrlEnvironment(): string | undefined {
  const configuredUrl = process.env[EVE_BASE_URL_ENV];

  if (configuredUrl === undefined || configuredUrl.trim().length === 0) {
    return undefined;
  }

  return normalizeOrigin(configuredUrl);
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resolveEveCacheDirectory(appRoot: string): string {
  return join(appRoot, EVE_CACHE_DIRECTORY_NAME);
}

function resolveEveDevServerRegistryPath(appRoot: string): string {
  return join(resolveEveCacheDirectory(appRoot), EVE_NEXT_DEV_SERVER_FILE_NAME);
}

function resolveEveDevServerLockPath(appRoot: string): string {
  return join(resolveEveCacheDirectory(appRoot), EVE_NEXT_DEV_SERVER_LOCK_FILE_NAME);
}

function normalizeDevServerRegistry(value: unknown): EveDevServerRegistry | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (
    typeof value.appRoot !== "string" ||
    typeof value.origin !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return undefined;
  }

  if (value.pid !== null && typeof value.pid !== "number") {
    return undefined;
  }

  try {
    return {
      appRoot: value.appRoot,
      origin: normalizeOrigin(value.origin),
      pid: value.pid,
      updatedAt: value.updatedAt,
    };
  } catch {
    return undefined;
  }
}

async function isEveServerHealthy(origin: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, 1_000);

  try {
    const response = await fetch(joinRoutePrefix(origin, `${EVE_ROUTE_PREFIX}/health`), {
      signal: controller.signal,
    });

    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function readUsableEveDevServerRegistry(appRoot: string): Promise<string | undefined> {
  try {
    const registry = normalizeDevServerRegistry(
      JSON.parse(await readFile(resolveEveDevServerRegistryPath(appRoot), "utf8")) as unknown,
    );

    if (registry === undefined || registry.appRoot !== appRoot) {
      return undefined;
    }

    if (!(await isEveServerHealthy(registry.origin))) {
      return undefined;
    }

    return registry.origin;
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return undefined;
    }

    throw error;
  }
}

async function writeEveDevServerRegistry(appRoot: string, handle: EveProcessHandle): Promise<void> {
  await mkdir(resolveEveCacheDirectory(appRoot), {
    recursive: true,
  });
  await writeFile(
    resolveEveDevServerRegistryPath(appRoot),
    `${JSON.stringify(
      {
        appRoot,
        origin: handle.origin,
        pid: handle.process?.pid ?? null,
        updatedAt: new Date().toISOString(),
      } satisfies EveDevServerRegistry,
      null,
      2,
    )}\n`,
  );
}

async function removeStaleEveDevServerLock(lockPath: string): Promise<void> {
  try {
    const lockStat = await stat(lockPath);
    if (Date.now() - lockStat.mtimeMs > DEV_SERVER_STALE_LOCK_MS) {
      await rm(lockPath, {
        force: true,
      });
    }
  } catch (error) {
    if (!isNodeErrorWithCode(error, "ENOENT")) {
      throw error;
    }
  }
}

async function acquireEveDevServerLock(
  appRoot: string,
  timeoutMs: number,
): Promise<() => Promise<void>> {
  const cacheDirectory = resolveEveCacheDirectory(appRoot);
  const lockPath = resolveEveDevServerLockPath(appRoot);
  const deadline = Date.now() + timeoutMs;

  await mkdir(cacheDirectory, {
    recursive: true,
  });

  while (true) {
    try {
      const lockFile = await open(lockPath, "wx");
      await lockFile.writeFile(`${String(process.pid)}\n`);
      await lockFile.close();

      return async () => {
        await rm(lockPath, {
          force: true,
        });
      };
    } catch (error) {
      if (!isNodeErrorWithCode(error, "EEXIST")) {
        throw error;
      }

      const registeredOrigin = await readUsableEveDevServerRegistry(appRoot);
      if (registeredOrigin !== undefined) {
        return async () => {};
      }

      await removeStaleEveDevServerLock(lockPath);

      if (Date.now() > deadline) {
        throw new Error(
          `Timed out after ${timeoutMs}ms waiting for another Next.js process to start eve.`,
        );
      }

      await delay(DEV_SERVER_REGISTRY_POLL_MS);
    }
  }
}

function createEveBinaryPath(): string {
  return join(resolvePackageRoot(), "bin", "eve.js");
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}

function parseLocalServerOrigin(urlText: string): string | undefined {
  const url = URL.parse(urlText);
  // Dev-server discovery reads mixed subprocess output. Build metadata and
  // dependency warnings can print unrelated URLs before eve reports its listener,
  // but withEve only owns the app-local loopback server it started.
  if (
    url === null ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !isLoopbackHostname(url.hostname) ||
    url.port.length === 0
  ) {
    return undefined;
  }

  return url.origin;
}

function findLocalServerOrigin(output: string): string | undefined {
  for (const match of output.matchAll(SERVER_URL_CANDIDATE_PATTERN)) {
    const candidate = match[0];
    const origin = parseLocalServerOrigin(candidate);
    if (origin !== undefined) {
      return origin;
    }
  }

  return undefined;
}

function formatEveDevOutputLine(line: string, logLabel: string | undefined): string | undefined {
  const normalizedLine = line.replace(/\r$/, "");
  const trimmedLine = normalizedLine.replace(ANSI_ESCAPE_PATTERN, "").trim();

  if (
    trimmedLine.length === 0 ||
    /^☰eve\b/.test(trimmedLine) ||
    trimmedLine === "CONFIGURATION_FIELD_CONFLICT" ||
    trimmedLine.startsWith("[CONFIGURATION_FIELD_CONFLICT]")
  ) {
    return undefined;
  }

  const tag = logLabel === undefined ? "[eve:dev]" : `[eve:dev:${logLabel}]`;
  const serverMatch = /server listening at\s+(https?:\/\/[^\s]+)/i.exec(normalizedLine);
  if (serverMatch !== null) {
    return `${tag} server listening at ${serverMatch[1]}`;
  }

  return `${tag} ${normalizedLine}`;
}

function createEveDevOutputWriter(input: {
  readonly logLabel?: string;
  readonly stream: NodeJS.WriteStream;
}): {
  readonly flush: () => void;
  readonly write: (chunk: Buffer) => void;
} {
  let pendingLine = "";

  const writeLine = (line: string) => {
    const formattedLine = formatEveDevOutputLine(line, input.logLabel);
    if (formattedLine !== undefined) {
      input.stream.write(`${formattedLine}\n`);
    }
  };

  return {
    flush() {
      if (pendingLine.length === 0) {
        return;
      }

      writeLine(pendingLine);
      pendingLine = "";
    },
    write(chunk) {
      pendingLine += chunk.toString("utf8");
      const lines = pendingLine.split("\n");
      pendingLine = lines.pop() ?? "";

      for (const line of lines) {
        writeLine(line);
      }
    },
  };
}

function startServerProcess(input: {
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd: string;
  readonly env?: Record<string, string>;
  readonly logLabel?: string;
  readonly timeoutMs?: number;
}): Promise<EveProcessHandle> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: {
        ...process.env,
        ...input.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderrWriter = createEveDevOutputWriter({
      logLabel: input.logLabel,
      stream: process.stderr,
    });
    const stdoutWriter = createEveDevOutputWriter({
      logLabel: input.logLabel,
      stream: process.stdout,
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(
        new Error(
          `Timed out after ${input.timeoutMs ?? DEFAULT_SERVER_READY_TIMEOUT_MS}ms waiting for eve to print its server URL.`,
        ),
      );
    }, input.timeoutMs ?? DEFAULT_SERVER_READY_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timeout);
      child.off("error", handleError);
      child.off("exit", handleEarlyExit);
    };
    const flushOutput = () => {
      stdoutWriter.flush();
      stderrWriter.flush();
    };
    const handleError = (error: Error) => {
      flushOutput();
      cleanup();
      reject(error);
    };
    const handleEarlyExit = (code: number | null, signal: NodeJS.Signals | null) => {
      flushOutput();
      cleanup();
      reject(
        new Error(
          `eve server process exited before printing its server URL (code ${String(code)}, signal ${String(signal)}).`,
        ),
      );
    };
    const handleOutput = (chunk: Buffer) => {
      const origin = findLocalServerOrigin(chunk.toString("utf8"));

      if (origin === undefined) {
        return;
      }

      cleanup();
      resolvePromise({
        origin,
        process: child,
      });
    };
    const handleStdout = (chunk: Buffer) => {
      stdoutWriter.write(chunk);
      handleOutput(chunk);
    };
    const handleStderr = (chunk: Buffer) => {
      stderrWriter.write(chunk);
      handleOutput(chunk);
    };

    child.once("error", handleError);
    child.once("exit", handleEarlyExit);
    child.stdout.on("data", handleStdout);
    child.stderr.on("data", handleStderr);
  });
}

function installProcessShutdown(handle: EveProcessHandle): EveProcessHandle {
  const childProcess = handle.process;

  if (childProcess === undefined) {
    return handle;
  }

  const close = () => {
    if (!childProcess.killed) {
      childProcess.kill();
    }
  };

  process.once("beforeExit", close);
  process.once("exit", close);

  return handle;
}

function startEveDevServer(
  appRoot: string,
  timeoutMs: number,
  logLabel: string | undefined,
): Promise<EveProcessHandle> {
  return startServerProcess({
    args: [createEveBinaryPath(), "dev", "--no-ui", "--port", "0"],
    command: process.execPath,
    cwd: appRoot,
    logLabel,
    timeoutMs,
  }).then((handle) => {
    return installProcessShutdown(handle);
  });
}

function startEveProductionServer(input: {
  readonly appRoot: string;
  readonly origin: string;
}): Promise<EveProcessHandle> | undefined {
  const parsedOrigin = new URL(input.origin);
  const port = parsedOrigin.port;
  const serverEntry = join(input.appRoot, ".output", "server", "index.mjs");

  if (!existsSync(serverEntry)) {
    return undefined;
  }

  return startServerProcess({
    args: [serverEntry],
    command: process.execPath,
    cwd: input.appRoot,
    env: {
      HOST: parsedOrigin.hostname,
      NITRO_HOST: parsedOrigin.hostname,
      NITRO_PORT: port,
      PORT: port,
    },
  }).then(installProcessShutdown);
}

async function resolveSharedEveDevServer(
  appRoot: string,
  timeoutMs: number,
  logLabel: string | undefined,
): Promise<EveProcessHandle> {
  const registeredOrigin = await readUsableEveDevServerRegistry(appRoot);
  if (registeredOrigin !== undefined) {
    return {
      origin: registeredOrigin,
    };
  }

  const releaseLock = await acquireEveDevServerLock(appRoot, timeoutMs);

  try {
    const lockedRegisteredOrigin = await readUsableEveDevServerRegistry(appRoot);
    if (lockedRegisteredOrigin !== undefined) {
      return {
        origin: lockedRegisteredOrigin,
      };
    }

    const handle = await startEveDevServer(appRoot, timeoutMs, logLabel);
    await writeEveDevServerRegistry(appRoot, handle);
    return handle;
  } finally {
    await releaseLock();
  }
}

export async function resolveEveDestinationPrefix(input: {
  readonly appRoot: string;
  readonly devServerTimeoutMs?: number;
  readonly logLabel?: string;
  readonly phase: string;
  readonly productionDestinationPrefix: string;
  readonly productionServerOrigin?: string;
}): Promise<string> {
  const state = getGlobalState();

  if (process.env.NODE_ENV === "production") {
    if (input.phase === NEXT_PHASE_PRODUCTION_BUILD) {
      return input.productionDestinationPrefix;
    }

    const key = `production:${input.appRoot}`;
    let productionServer = state.servers.get(key);
    if (productionServer === undefined) {
      productionServer =
        process.env.VERCEL || input.productionServerOrigin === undefined
          ? undefined
          : startEveProductionServer({
              appRoot: input.appRoot,
              origin: input.productionServerOrigin,
            });
      if (productionServer !== undefined) {
        productionServer = productionServer.catch((error) => {
          state.servers.delete(key);
          throw error;
        });
        state.servers.set(key, productionServer);
      }
    }

    if (productionServer !== undefined) {
      return (await productionServer).origin;
    }

    return input.productionDestinationPrefix;
  }

  const configuredEveBaseUrl = readEveBaseUrlEnvironment();
  if (configuredEveBaseUrl !== undefined) {
    return configuredEveBaseUrl;
  }

  if (process.env.NODE_ENV !== "development") {
    return input.productionDestinationPrefix;
  }

  const key = `dev:${input.appRoot}`;
  let server = state.servers.get(key);

  if (server === undefined) {
    server = resolveSharedEveDevServer(
      input.appRoot,
      input.devServerTimeoutMs ?? DEV_SERVER_REGISTRY_TIMEOUT_MS,
      input.logLabel,
    ).catch((error) => {
      state.servers.delete(key);
      throw error;
    });
    state.servers.set(key, server);
  }

  return (await server).origin;
}
