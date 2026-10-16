import type { SandboxDeleteOptions } from "#shared/sandbox-provider.js";

/** Options for running a command in the sandbox's working directory. */
export interface SandboxRunOptions {
  command: string;
  workingDirectory?: string;
  /** Per-command environment overrides; avoids embedding credentials in command strings. */
  env?: Record<string, string>;
  abortSignal?: AbortSignal;
}

/** Result of a completed sandbox command. */
export interface SandboxCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Options for starting a process without waiting for it to exit. */
export interface SandboxSpawnOptions extends SandboxRunOptions {}

/** A running process with byte streams and explicit lifecycle operations. */
export interface SandboxProcess {
  readonly pid?: number;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  wait(): PromiseLike<{ exitCode: number }>;
  kill(): PromiseLike<void>;
}

/** Options for reading a file; relative paths resolve from `/workspace`. */
export interface SandboxReadFileOptions {
  path: string;
  abortSignal?: AbortSignal;
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
  abortSignal?: AbortSignal;
}

/** Writes a byte stream, creating parent directories and overwriting existing content. */
export interface SandboxWriteFileOptions extends WriteOptions<ReadableStream<Uint8Array>> {}

/** Writes a complete byte buffer. */
export interface SandboxWriteBinaryFileOptions extends WriteOptions<Uint8Array> {}

/** Writes text with the requested encoding (UTF-8 by default). */
export interface SandboxWriteTextFileOptions extends WriteOptions<string> {
  encoding?: string;
}

/** Removes a path; relative paths resolve from `/workspace`. */
export interface SandboxRemovePathOptions {
  readonly abortSignal?: AbortSignal;
  readonly force?: boolean;
  readonly path: string;
  readonly recursive?: boolean;
}

/** eve-owned sandbox I/O and workspace-relative path handling. */
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

/** Provider primitives; the shared builder implements binary, text, and run conveniences. */
export interface InternalSandboxSession extends Pick<
  SandboxSession,
  "spawn" | "readFile" | "writeFile" | "removePath" | "resolvePath"
> {}
