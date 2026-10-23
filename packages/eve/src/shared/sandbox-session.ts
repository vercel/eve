import type { SandboxDeleteOptions } from "#shared/sandbox-provider.js";

/**
 * Options for running one command, or spawning one process, in a sandbox.
 * `env` holds per-call variables, merged over the sandbox's environment.
 * Aborting kills the process.
 */
export interface SandboxRunOptions {
  readonly abortSignal?: AbortSignal;
  readonly command: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Relative directories resolve from the workspace root, which is also the default. */
  readonly workingDirectory?: string;
}

/** Options for spawning one long-running process in a sandbox. */
export type SandboxSpawnOptions = SandboxRunOptions;

/** Result of one finished sandbox command. A nonzero `exitCode` does not throw. */
export interface SandboxCommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

/** Handle to a long-running process spawned via {@link SandboxSession.spawn}. */
export interface SandboxProcess {
  readonly pid?: number;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  /** Terminates the process. Idempotent. */
  kill(): Promise<void>;
  wait(): Promise<{ readonly exitCode: number }>;
}

/** Options for reading one file as a stream of bytes. */
export interface SandboxReadFileOptions {
  readonly abortSignal?: AbortSignal;
  readonly path: string;
}

/** Options for reading one file as raw bytes. */
export type SandboxReadBinaryFileOptions = SandboxReadFileOptions;

/**
 * Options for reading one text file from a sandbox.
 *
 * `"utf-8"` decodes with `TextDecoder` in fatal mode; other encodings fall
 * back to Node's `Buffer.toString(encoding)`. Line ranges are 1-based and
 * inclusive; `endLine` past the file's line count returns through EOF
 * without error.
 */
export interface SandboxReadTextFileOptions extends SandboxReadFileOptions {
  readonly encoding?: string;
  readonly endLine?: number;
  readonly startLine?: number;
}

/** Options for writing one file from a stream of bytes. */
export interface SandboxWriteFileOptions {
  readonly abortSignal?: AbortSignal;
  readonly content: ReadableStream<Uint8Array>;
  readonly path: string;
}

/** Options for writing one file from raw bytes. */
export interface SandboxWriteBinaryFileOptions {
  readonly abortSignal?: AbortSignal;
  readonly content: Uint8Array;
  readonly path: string;
}

/** Options for writing one text file to a sandbox. Encodes as UTF-8 unless `encoding` is set. */
export interface SandboxWriteTextFileOptions {
  readonly abortSignal?: AbortSignal;
  readonly content: string;
  readonly encoding?: string;
  readonly path: string;
}

/**
 * Options for writing several files from raw bytes in one batch.
 */
export interface SandboxWriteFilesOptions {
  readonly abortSignal?: AbortSignal;
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
  readonly abortSignal?: AbortSignal;
  readonly force?: boolean;
  readonly path: string;
  readonly recursive?: boolean;
}

/**
 * The sandbox session that authored tools, hooks, and `prepare` receive.
 *
 * Relative paths resolve from the workspace root, where commands start by
 * default: `/workspace` on every built-in provider. Absolute paths pass
 * through unchanged. Writes create missing parent directories and overwrite
 * existing files. Reads resolve to `null` only when the path does not exist.
 *
 * The method set stays assignable to the AI SDK's
 * `Experimental_SandboxSession`, apart from its `description`.
 */
export interface SandboxSession {
  run(options: SandboxRunOptions): Promise<SandboxCommandResult>;
  spawn(options: SandboxSpawnOptions): Promise<SandboxProcess>;
  readFile(options: SandboxReadFileOptions): Promise<ReadableStream<Uint8Array> | null>;
  readBinaryFile(options: SandboxReadBinaryFileOptions): Promise<Uint8Array | null>;
  readTextFile(options: SandboxReadTextFileOptions): Promise<string | null>;
  writeFile(options: SandboxWriteFileOptions): Promise<void>;
  writeBinaryFile(options: SandboxWriteBinaryFileOptions): Promise<void>;
  writeTextFile(options: SandboxWriteTextFileOptions): Promise<void>;
  /**
   * Writes several files in as few provider calls as the provider allows. A
   * batch is not atomic: a rejected batch may leave earlier files written.
   */
  writeFiles(options: SandboxWriteFilesOptions): Promise<void>;
  /**
   * Anchors a sandbox-relative path to the workspace root and returns the
   * resulting absolute path, so `resolvePath(".")` is the root itself. The
   * read and write methods already apply it.
   */
  resolvePath(path: string): string;
  /** Removes one file or directory from the sandbox filesystem. */
  removePath(options: SandboxRemovePathOptions): Promise<void>;
}

export interface RuntimeSandboxSession extends SandboxSession {
  /** Permanently deletes this sandbox and its disposable provider state. */
  delete(options?: SandboxDeleteOptions): Promise<void>;
  /**
   * Stops the backing sandbox compute while preserving the durable session.
   * A later runtime callback reopens the session through its configured
   * provider. Providers may also support resuming the same handle.
   */
  stop(): Promise<void>;
}

export type RuntimeSandboxSessionFor<Session extends SandboxSession> = Session &
  Pick<RuntimeSandboxSession, "delete" | "stop">;
