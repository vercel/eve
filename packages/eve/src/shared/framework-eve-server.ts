import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { resolvePackageRoot } from "#internal/application/package.js";
import { readDevelopmentRuntimeArtifactsRevision } from "#services/dev-client/runtime-artifacts.js";
import { isLoopbackHostname } from "#shared/network-address.js";

/** Default time to wait for an eve server spawned by a framework integration. */
export const DEFAULT_EVE_SERVER_TIMEOUT_MS = 180_000;

const DEV_SERVER_REGISTRY_POLL_MS = 100;
const DEV_SERVER_READINESS_TIMEOUT_MS = 1_000;
const DEV_SERVER_STALE_LOCK_MS = 30_000;
const EVE_CACHE_DIRECTORY_NAME = ".eve";
const ANSI_ESCAPE = String.fromCharCode(27);
const ANSI_ESCAPE_PATTERN = new RegExp(`${ANSI_ESCAPE}\\[[0-?]*[ -/]*[@-~]`, "g");
const SERVER_URL_CANDIDATE_PATTERN = /https?:\/\/[^\s"'<>]+/g;

/**
 * Framework that owns the eve server process. `label` appears in errors;
 * `slug` keeps each framework's dev-server registry and lock separate.
 */
export interface EveFrameworkHost {
  readonly label: string;
  readonly slug: string;
}

export interface EveProcessHandle {
  readonly origin: string;
  readonly process?: ChildProcess;
}

interface EveDevServerRegistry {
  readonly appRoot: string;
  readonly origin: string;
  readonly pid: number | null;
  readonly updatedAt: string;
}

function normalizeOrigin(origin: string): string {
  return new URL(origin).origin;
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

function resolveEveDevServerRegistryPath(appRoot: string, host: EveFrameworkHost): string {
  return join(resolveEveCacheDirectory(appRoot), `${host.slug}-dev-server.json`);
}

function resolveEveDevServerLockPath(appRoot: string, host: EveFrameworkHost): string {
  return join(resolveEveCacheDirectory(appRoot), `${host.slug}-dev-server.lock`);
}

/**
 * Validate a framework-supplied dev-server timeout. Returns `undefined` when
 * unset so callers fall back to {@link DEFAULT_EVE_SERVER_TIMEOUT_MS}.
 */
export function resolveDevServerTimeout(
  timeoutMs: number | undefined,
  host: EveFrameworkHost,
): number | undefined {
  if (timeoutMs === undefined) {
    return undefined;
  }

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`eve ${host.label} development server timeout must be a positive number.`);
  }

  return timeoutMs;
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

async function readUsableEveDevServerRegistry(
  appRoot: string,
  host: EveFrameworkHost,
): Promise<string | undefined> {
  try {
    const registry = normalizeDevServerRegistry(
      JSON.parse(await readFile(resolveEveDevServerRegistryPath(appRoot, host), "utf8")) as unknown,
    );

    if (registry === undefined || registry.appRoot !== appRoot) {
      return undefined;
    }

    if (
      (await readDevelopmentRuntimeArtifactsRevision({
        serverUrl: registry.origin,
        timeoutMs: DEV_SERVER_READINESS_TIMEOUT_MS,
      })) === undefined
    ) {
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

async function writeEveDevServerRegistry(
  appRoot: string,
  host: EveFrameworkHost,
  handle: EveProcessHandle,
): Promise<void> {
  await mkdir(resolveEveCacheDirectory(appRoot), {
    recursive: true,
  });
  await writeFile(
    resolveEveDevServerRegistryPath(appRoot, host),
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
  host: EveFrameworkHost,
  timeoutMs: number,
): Promise<() => Promise<void>> {
  const cacheDirectory = resolveEveCacheDirectory(appRoot);
  const lockPath = resolveEveDevServerLockPath(appRoot, host);
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

      const registeredOrigin = await readUsableEveDevServerRegistry(appRoot, host);
      if (registeredOrigin !== undefined) {
        return async () => {};
      }

      await removeStaleEveDevServerLock(lockPath);

      if (Date.now() > deadline) {
        throw new Error(
          `Timed out after ${timeoutMs}ms waiting for another ${host.label} process to start eve.`,
        );
      }

      await delay(DEV_SERVER_REGISTRY_POLL_MS);
    }
  }
}

function createEveBinaryPath(): string {
  return join(resolvePackageRoot(), "bin", "eve.js");
}

function parseLocalServerOrigin(urlText: string): string | undefined {
  const url = URL.parse(urlText);
  // Dev-server discovery reads mixed subprocess output. Build metadata and
  // dependency warnings can print unrelated URLs before eve reports its listener,
  // but the integration only owns the app-local loopback server it started.
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
    const origin = parseLocalServerOrigin(match[0]);
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
  const timeoutMs = input.timeoutMs ?? DEFAULT_EVE_SERVER_TIMEOUT_MS;

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
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for eve to print its server URL.`));
    }, timeoutMs);

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

function startEveDevServer(input: {
  readonly appRoot: string;
  readonly logLabel?: string;
  readonly timeoutMs: number;
  readonly workspaceAgentName?: string;
}): Promise<EveProcessHandle> {
  return startServerProcess({
    args: [
      createEveBinaryPath(),
      "dev",
      "--no-ui",
      "--port",
      "0",
      ...(input.workspaceAgentName === undefined ? [] : ["--agent", input.workspaceAgentName]),
    ],
    command: process.execPath,
    cwd: input.appRoot,
    logLabel: input.logLabel,
    timeoutMs: input.timeoutMs,
  }).then(installProcessShutdown);
}

/**
 * Serve an existing `eve build` output from `.output/server/index.mjs` on
 * {@link input.origin}'s loopback port.
 */
export function startEveProductionServer(input: {
  readonly appRoot: string;
  readonly host: EveFrameworkHost;
  readonly origin: string;
}): Promise<EveProcessHandle> {
  const parsedOrigin = new URL(input.origin);
  const port = parsedOrigin.port;
  const serverEntry = join(input.appRoot, ".output", "server", "index.mjs");

  if (!existsSync(serverEntry)) {
    throw new Error(
      `eve production output is missing at ${serverEntry}. Run eve build from ${input.appRoot} before starting ${input.host.label}.`,
    );
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

/**
 * Resolve a shared eve dev server for `appRoot`, reusing a healthy registered
 * server when one exists and otherwise spawning `eve dev` behind a
 * cross-process lock so concurrent framework processes don't each boot eve.
 * `process` is set only when this call spawned the server.
 */
export async function resolveSharedEveDevServer(input: {
  readonly appRoot: string;
  readonly host: EveFrameworkHost;
  readonly logLabel?: string;
  readonly timeoutMs?: number;
  /** Workspace member selected when spawning the local eve dev server. */
  readonly workspaceAgentName?: string;
}): Promise<EveProcessHandle> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_EVE_SERVER_TIMEOUT_MS;
  const registeredOrigin = await readUsableEveDevServerRegistry(input.appRoot, input.host);
  if (registeredOrigin !== undefined) {
    return {
      origin: registeredOrigin,
    };
  }

  const releaseLock = await acquireEveDevServerLock(input.appRoot, input.host, timeoutMs);

  try {
    const lockedRegisteredOrigin = await readUsableEveDevServerRegistry(input.appRoot, input.host);
    if (lockedRegisteredOrigin !== undefined) {
      return {
        origin: lockedRegisteredOrigin,
      };
    }

    const handle = await startEveDevServer({
      appRoot: input.appRoot,
      logLabel: input.logLabel,
      timeoutMs,
      workspaceAgentName: input.workspaceAgentName,
    });
    await writeEveDevServerRegistry(input.appRoot, input.host, handle);
    return handle;
  } finally {
    await releaseLock();
  }
}
