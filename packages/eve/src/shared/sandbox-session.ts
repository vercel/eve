import type { SandboxDeleteOptions } from "#shared/sandbox-provider.js";

/** Options for running a command in the sandbox's working directory. */
export interface SandboxRunOptions {
  command: string;
  /** Relative directories resolve from the workspace root, which is also the default. */
  workingDirectory?: string;
  /** Per-command environment overrides; avoids embedding credentials in command strings. */
  env?: Record<string, string>;
  signal?: AbortSignal;
}

/** Result of a completed sandbox command. */
export interface SandboxCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Options for starting a process without waiting for it to exit. */
export interface SandboxSpawnOptions extends SandboxRunOptions {
  /** Opens a writable `stdin` on the process. Rejects on providers without stdin support. */
  stdin?: boolean;
}

/** A running process with byte streams and explicit lifecycle operations. */
export interface SandboxProcess {
  readonly pid?: number;
  /** Present when spawned with `stdin: true`. Closing it sends EOF. */
  readonly stdin?: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  wait(): PromiseLike<{ exitCode: number }>;
  kill(): PromiseLike<void>;
}

/** Options for reading a file; relative paths resolve from `/workspace`. */
export interface SandboxReadFileOptions {
  path: string;
  signal?: AbortSignal;
}

/** Options for reading all bytes of a file. */
export interface SandboxReadBinaryFileOptions extends SandboxReadFileOptions {}

/** Text decoding and 1-based inclusive line selection. Missing files return `null`. */
export interface SandboxReadTextFileOptions extends SandboxReadFileOptions {
  encoding?: string;
  startLine?: number;
  endLine?: number;
}

interface WriteOptions<T> {
  path: string;
  content: T;
  signal?: AbortSignal;
}

/** Writes a byte stream, creating parent directories and overwriting existing content. */
export interface SandboxWriteFileOptions extends WriteOptions<ReadableStream<Uint8Array>> {}

/** Writes a complete byte buffer. */
export interface SandboxWriteBinaryFileOptions extends WriteOptions<Uint8Array> {}

/** Writes text with the requested encoding (UTF-8 by default). */
export interface SandboxWriteTextFileOptions extends WriteOptions<string> {
  encoding?: string;
}

/** Writes several already-resolved files from raw bytes in one batch. */
export interface SandboxWriteFilesOptions {
  readonly signal?: AbortSignal;
  readonly files: readonly { readonly content: Uint8Array; readonly path: string }[];
}

/**
 * Options for removing a path from a sandbox.
 *
 * Relative paths resolve from the workspace root; absolute paths pass through.
 * `force` ignores missing paths. `recursive` permits removing non-empty
 * directories.
 */
export interface SandboxRemovePathOptions {
  readonly signal?: AbortSignal;
  readonly force?: boolean;
  readonly path: string;
  readonly recursive?: boolean;
}

/**
 * eve-owned sandbox I/O that authored tools, hooks, and `prepare` receive.
 *
 * Relative paths resolve from the workspace root, where commands start by
 * default: `/workspace` on every built-in provider. Absolute paths pass
 * through unchanged. Writes create missing parent directories and overwrite
 * existing files. Reads resolve to `null` only when the path does not exist.
 */
export interface SandboxSession {
  readonly run: (options: SandboxRunOptions) => PromiseLike<SandboxCommandResult>;
  readonly spawn: (options: SandboxSpawnOptions) => PromiseLike<SandboxProcess>;
  readonly readFile: (
    options: SandboxReadFileOptions,
  ) => PromiseLike<ReadableStream<Uint8Array> | null>;
  readonly readBinaryFile: (
    options: SandboxReadBinaryFileOptions,
  ) => PromiseLike<Uint8Array | null>;
  readonly readTextFile: (options: SandboxReadTextFileOptions) => PromiseLike<string | null>;
  readonly writeFile: (options: SandboxWriteFileOptions) => PromiseLike<void>;
  readonly writeBinaryFile: (options: SandboxWriteBinaryFileOptions) => PromiseLike<void>;
  readonly writeTextFile: (options: SandboxWriteTextFileOptions) => PromiseLike<void>;
  /** Writes several files in as few provider calls as possible; a rejected batch may leave earlier files written. */
  readonly writeFiles: (options: SandboxWriteFilesOptions) => PromiseLike<void>;
  /**
   * Anchors a sandbox-relative path to the workspace root and returns the
   * resulting absolute path, so `resolvePath(".")` is the root itself. The
   * read and write methods already apply it.
   */
  resolvePath(path: string): string;
  removePath(options: SandboxRemovePathOptions): Promise<void>;
}

/** Options for `sandbox.keepRunning()`. */
export interface SandboxKeepRunningOptions {
  /**
   * How long to keep the sandbox running, in milliseconds from now. Greater
   * than 0 and at most 86400000 (24 hours). Call again to extend.
   */
  readonly forMs: number;
  /**
   * A shell command that says whether the sandbox is still needed. eve runs
   * it in the workspace root, without resuming the sandbox, about every 5
   * minutes while the session is idle or its turn is waiting. The sandbox
   * keeps running only while the command exits 0. The command has 10
   * seconds: one that cannot run, or does not finish in time, counts as
   * exiting 0. eve stores the command with the session, so keep secrets out
   * of it. At most 1,000 characters. Without it, the sandbox keeps running
   * for all of `forMs`.
   */
  readonly while?: string;
}

/** What `sandbox.keepRunning()` resolves to. */
export interface SandboxKeepRunningResult {
  /**
   * When this call stops keeping the sandbox running, or `null` when the call
   * has no effect: eve doesn't stop this sandbox when its session goes idle,
   * the calling session doesn't own it, or the sandbox is stopped.
   */
  readonly until: Date | null;
}

/** A provider session plus the runtime's disposable-resource lifecycle. */
export type RuntimeSandboxSession<Session extends SandboxSession = SandboxSession> = Session & {
  /** Permanently deletes the sandbox and its disposable provider state. */
  delete(options?: SandboxDeleteOptions): Promise<void>;
  /**
   * Keeps the sandbox running after the session goes idle, instead of
   * stopping it after the environment's `idleTimeoutMs`. The sandbox keeps
   * running until `forMs` has passed or `while` exits non-zero, whichever
   * comes first, and then stops like any idle sandbox: files persist,
   * processes end, and the next use resumes it. A call with the same `while`
   * as an earlier one moves that call's time later, never earlier. One
   * sandbox has at most 8 different `while` commands at a time. `stop()` and
   * `delete()` end every call's effect.
   */
  keepRunning(options: SandboxKeepRunningOptions): Promise<SandboxKeepRunningResult>;
  /** Stops compute while retaining the durable session for a later reopen. */
  stop(): Promise<void>;
};
