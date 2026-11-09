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

/** A provider session plus the runtime's disposable-resource lifecycle. */
export type RuntimeSandboxSession<Session extends SandboxSession = SandboxSession> = Session & {
  /** Permanently deletes the sandbox and its disposable provider state. */
  delete(options?: SandboxDeleteOptions): Promise<void>;
  /** Stops compute while retaining the durable session for a later reopen. */
  stop(): Promise<void>;
};
