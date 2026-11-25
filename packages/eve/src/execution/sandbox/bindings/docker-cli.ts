import { spawn, spawnSync } from "#runtime-env/child-process.js";
import { Readable, Writable } from "node:stream";

/**
 * Buffered result of one `docker …` invocation.
 *
 * `stdout` decodes the raw bytes as UTF-8 for the common text case;
 * `stdoutBytes` preserves the exact bytes for binary payloads (for
 * example reading a file out of a container via `cat`).
 */
export interface DockerCommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
  readonly stdoutBytes: Buffer;
}

/**
 * Options for one buffered {@link DockerCli.run} invocation.
 */
export interface DockerRunOptions {
  readonly signal?: AbortSignal;
  readonly stdin?: Uint8Array;
}

/**
 * Handle to one streaming `docker …` invocation (e.g. `docker exec`).
 * Mirrors the AI SDK `Experimental_SandboxProcess` stream/wait/kill
 * shape so the sandbox engine can adapt it directly.
 */
export interface DockerProcess {
  readonly stdin?: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  wait(): Promise<{ exitCode: number }>;
  kill(): Promise<void>;
}

/**
 * Minimal Docker CLI driver the local sandbox engine runs on. A thin
 * subprocess wrapper in production; injectable so engine logic is unit
 * testable without a Docker daemon.
 */
export interface DockerCli {
  /** Runs `docker <args>` to completion, buffering stdout/stderr. */
  run(args: readonly string[], options?: DockerRunOptions): Promise<DockerCommandResult>;
  /** Spawns `docker <args>` with streaming stdout/stderr. */
  stream(
    args: readonly string[],
    options?: { readonly signal?: AbortSignal; readonly stdin?: boolean },
  ): DockerProcess;
}

export class DockerUnavailableError extends Error {
  readonly hint =
    "Install and start Docker Desktop, OrbStack, Colima, or another runtime exposing a " +
    "Docker-compatible `docker` CLI (or point EVE_DOCKER_PATH at one, e.g. Podman). " +
    "Alternatively use the dependency-free JustBashSandbox, " +
    "VercelSandbox, or DefaultSandbox to pick by availability.";

  constructor(cause?: unknown) {
    super("The Docker sandbox provider requires Docker, but the `docker` CLI was not found.", {
      cause,
    });
    this.name = "DockerUnavailableError";
  }
}

export class DockerDaemonUnavailableError extends Error {
  readonly hint =
    "Start Docker Desktop (or your Docker-compatible runtime) and retry. Alternatively use " +
    "the dependency-free JustBashSandbox (installed automatically " +
    "by `eve dev`, or `pnpm add -D just-bash`), VercelSandbox, or DefaultSandbox " +
    "to pick by availability.";

  constructor(detail: string) {
    super(
      "The Docker sandbox provider requires a running Docker daemon, but it is not reachable. " +
        `Docker reported: ${detail}`,
    );
    this.name = "DockerDaemonUnavailableError";
  }
}

export async function assertDockerDaemonAvailable(cli: DockerCli): Promise<void> {
  const result = await cli.run(["version", "--format", "{{.Server.Version}}"]);
  if (result.exitCode !== 0) {
    throw new DockerDaemonUnavailableError(firstLine(result.stderr) || `exit ${result.exitCode}`);
  }
}

function resolveDockerExecutable(): string {
  const fromEnv = process.env.EVE_DOCKER_PATH?.trim();
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : "docker";
}

let cachedLinuxDockerAvailability: boolean | undefined;

export const LINUX_DOCKER_AVAILABILITY_ENV = "EVE_DEVELOPMENT_LINUX_DOCKER_AVAILABLE";

export function isLinuxDockerDaemonAvailableSync(): boolean {
  cachedLinuxDockerAvailability ??= readAdoptedAvailability() ?? probeLinuxDockerDaemonSync();
  return cachedLinuxDockerAvailability;
}

export function peekLinuxDockerDaemonAvailability(): boolean | undefined {
  return cachedLinuxDockerAvailability;
}

function readAdoptedAvailability(): boolean | undefined {
  const value = process.env[LINUX_DOCKER_AVAILABILITY_ENV];
  return value === "1" ? true : value === "0" ? false : undefined;
}

function probeLinuxDockerDaemonSync(): boolean {
  try {
    const result = spawnSync(resolveDockerExecutable(), ["version", "--format", "{{.Server.Os}}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      windowsHide: true,
    });
    return result.status === 0 && result.stdout.trim().toLowerCase() === "linux";
  } catch {
    return false;
  }
}

export function createDockerCli(): DockerCli {
  return {
    async run(args, options = {}) {
      throwIfAborted(options.signal);
      const child = spawn(resolveDockerExecutable(), args, {
        signal: options.signal,
        stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        windowsHide: true,
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

      if (options.stdin !== undefined) {
        child.stdin?.end(options.stdin);
      }

      const exitCode = await new Promise<number>((resolve, reject) => {
        child.on("error", (error) => reject(adaptSpawnError(error)));
        child.on("close", (code) => resolve(code ?? 1));
      });

      const stdoutBytes = Buffer.concat(stdoutChunks);
      return {
        exitCode,
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        stdout: stdoutBytes.toString("utf8"),
        stdoutBytes,
      };
    },
    stream(args, options = {}) {
      throwIfAborted(options.signal);
      const child = spawn(resolveDockerExecutable(), args, {
        signal: options.signal,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      if (options.stdin !== true) child.stdin.end();

      const exit = new Promise<number>((resolve, reject) => {
        child.on("error", (error) => reject(adaptSpawnError(error)));
        child.on("close", (code) => resolve(code ?? 1));
      });
      exit.catch(() => {});

      return {
        stdin:
          options.stdin === true
            ? (Writable.toWeb(child.stdin) as WritableStream<Uint8Array>)
            : undefined,
        stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
        async wait() {
          return { exitCode: await exit };
        },
        async kill() {
          child.kill("SIGKILL");
          await exit.catch(() => {});
        },
      };
    },
  };
}

function adaptSpawnError(error: NodeJS.ErrnoException): Error {
  if (error.code === "ENOENT") {
    return new DockerUnavailableError(error);
  }
  if (error.code === "ABORT_ERR") {
    return new DOMException("The operation was aborted.", "AbortError");
  }
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }
}

function firstLine(value: string): string {
  return value.split("\n", 1)[0]?.trim() ?? "";
}
