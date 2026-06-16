import { spawn, spawnSync } from "node:child_process";
import { Readable } from "node:stream";

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
  stream(args: readonly string[], options?: { readonly signal?: AbortSignal }): DockerProcess;
}

/**
 * Raised when the `docker` executable cannot be spawned at all (not
 * installed or not on `PATH`).
 */
export class DockerUnavailableError extends Error {
  constructor(cause?: unknown) {
    super(
      "The Docker sandbox backend requires Docker, but the `docker` CLI was not found. " +
        "Install and start Docker Desktop, OrbStack, Colima, or another runtime exposing a " +
        "Docker-compatible `docker` CLI (or point EVE_DOCKER_PATH at one, e.g. Podman). " +
        "Alternatively use microsandbox(), the dependency-free justbash(), " +
        "vercel(), or defaultSandbox() to pick by availability.",
      { cause },
    );
    this.name = "DockerUnavailableError";
  }
}

/**
 * Raised when the `docker` CLI exists but the daemon is not reachable.
 */
export class DockerDaemonUnavailableError extends Error {
  constructor(detail: string) {
    super(
      "The Docker sandbox backend requires a running Docker daemon, but it is not reachable. " +
        "Start Docker Desktop (or your Docker-compatible runtime) and retry. Alternatively use " +
        "microsandbox(), the dependency-free justbash() (installed automatically " +
        "by `eve dev`, or `pnpm add -D just-bash`), vercel(), or defaultSandbox() " +
        `to pick by availability. Docker reported: ${detail}`,
    );
    this.name = "DockerDaemonUnavailableError";
  }
}

/**
 * Verifies the Docker daemon answers before the engine performs its
 * first real operation, converting CLI/daemon failures into actionable
 * errors instead of letting individual commands fail obscurely.
 */
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

let cachedDockerAvailability: boolean | undefined;

/**
 * Synchronously probes whether a Docker daemon is reachable, for
 * `defaultSandbox()`'s availability chain. The result is cached for the
 * process lifetime: backend selection must be stable, and the probe
 * costs a subprocess round-trip.
 */
export function isDockerDaemonAvailableSync(): boolean {
  cachedDockerAvailability ??= probeDockerDaemonSync();
  return cachedDockerAvailability;
}

function probeDockerDaemonSync(): boolean {
  try {
    const result = spawnSync(
      resolveDockerExecutable(),
      ["version", "--format", "{{.Server.Version}}"],
      { stdio: "ignore", timeout: 5_000 },
    );
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Creates the production {@link DockerCli} that shells out to the
 * `docker` executable (override the binary with `EVE_DOCKER_PATH`).
 */
export function createDockerCli(): DockerCli {
  return {
    async run(args, options = {}) {
      throwIfAborted(options.signal);
      const child = spawn(resolveDockerExecutable(), args, {
        signal: options.signal,
        stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
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
        stdio: ["ignore", "pipe", "pipe"],
      });

      const exit = new Promise<number>((resolve, reject) => {
        child.on("error", (error) => reject(adaptSpawnError(error)));
        child.on("close", (code) => resolve(code ?? 1));
      });
      // Surface spawn/abort failures through `wait()` instead of an
      // unhandled rejection when the caller only consumes the streams.
      exit.catch(() => {});

      return {
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
