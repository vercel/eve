import type { Experimental_SandboxSession as AiSdkSandbox } from "ai";

import type { SandboxDeleteOptions } from "#shared/sandbox-provider.js";
import type { SandboxNetworkPolicy } from "#shared/sandbox-network-policy.js";

/**
 * Options for running one command in a sandbox. Shape mirrors the AI
 * SDK {@link AiSdkSandbox} `run` argument so authored code that targets
 * either surface uses the same call shape.
 */
export type SandboxRunOptions = Parameters<AiSdkSandbox["run"]>[0];

/**
 * Serializable result returned after running one sandbox command.
 */
export type SandboxCommandResult = Awaited<ReturnType<AiSdkSandbox["run"]>>;

/**
 * Options for spawning one long-running process in a sandbox. Shape
 * mirrors the AI SDK {@link AiSdkSandbox} `spawn` argument.
 */
export type SandboxSpawnOptions = Parameters<AiSdkSandbox["spawn"]>[0];

/**
 * Handle to a long-running process spawned via {@link SandboxSession.spawn}.
 * Mirrors the AI SDK `Experimental_SandboxProcess` type.
 */
export type SandboxProcess = Awaited<ReturnType<AiSdkSandbox["spawn"]>>;

/**
 * Options for reading one file as a stream of bytes.
 */
export type SandboxReadFileOptions = Parameters<AiSdkSandbox["readFile"]>[0];

/**
 * Options for reading one file as raw bytes.
 */
export type SandboxReadBinaryFileOptions = Parameters<AiSdkSandbox["readBinaryFile"]>[0];

/**
 * Options for reading one text file from a sandbox.
 *
 * `encoding`, `startLine`, and `endLine` are passed through to the
 * public-surface decoder. `"utf-8"` decodes with `TextDecoder` in fatal
 * mode; other encodings fall back to Node's `Buffer.toString(encoding)`.
 * Line ranges are 1-based and inclusive; `endLine` past the file's line
 * count returns through EOF without error.
 */
export type SandboxReadTextFileOptions = Parameters<AiSdkSandbox["readTextFile"]>[0];

/**
 * Options for writing one file from a stream of bytes.
 */
export type SandboxWriteFileOptions = Parameters<AiSdkSandbox["writeFile"]>[0];

/**
 * Options for writing one file from raw bytes.
 */
export type SandboxWriteBinaryFileOptions = Parameters<AiSdkSandbox["writeBinaryFile"]>[0];

/**
 * Options for writing one text file to a sandbox.
 */
export type SandboxWriteTextFileOptions = Parameters<AiSdkSandbox["writeTextFile"]>[0];

/**
 * Options for removing a path from a sandbox.
 *
 * Relative paths resolve from `/workspace`; absolute paths pass through.
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
 * Public eve-owned sandbox session exposed to authored lifecycle hooks.
 *
 * The eight I/O methods (`run`, `spawn`, `readFile`, `readBinaryFile`,
 * `readTextFile`, `writeFile`, `writeBinaryFile`, `writeTextFile`) are
 * pulled directly from the AI SDK {@link AiSdkSandbox} type, so authored
 * code that targets either surface uses identical signatures. `resolvePath`
 * is an eve-specific extension for `/workspace` path anchoring.
 *
 * Relative paths resolve from `/workspace`, the live working directory
 * for every provider. Absolute paths pass through unchanged.
 *
 */
export interface SandboxSession extends Pick<
  AiSdkSandbox,
  | "run"
  | "spawn"
  | "readFile"
  | "readBinaryFile"
  | "readTextFile"
  | "writeFile"
  | "writeBinaryFile"
  | "writeTextFile"
> {
  /**
   * Anchors a sandbox-relative path to `/workspace` and returns the
   * resulting absolute path.
   *
   * Relative paths resolve from `/workspace`; absolute paths pass through.
   * The read and write methods already apply this internally.
   */
  resolvePath(path: string): string;
  /**
   * Removes one file or directory from the sandbox filesystem.
   *
   * Relative paths resolve from `/workspace`; absolute paths pass through.
   */
  removePath(options: SandboxRemovePathOptions): Promise<void>;
}

/** Sandbox session capability exposed by environments with mutable networking. */
export interface NetworkPolicySandboxSession extends SandboxSession {
  /** Applies a firewall policy to the live sandbox. */
  setNetworkPolicy(policy: SandboxNetworkPolicy): Promise<void>;
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

/**
 * Internal sandbox session, used to construct the public {@link SandboxSession}.
 *
 * Provider implementations only need to provide byte-oriented file I/O and
 * a `spawn` primitive; the public surface (binary and text variants,
 * line-range slicing, encoding handling, the `run` wrapper) is built on
 * top of these primitives by `buildSandboxSession`.
 *
 * Each method's signature mirrors its public counterpart (and the AI
 * SDK {@link AiSdkSandbox} surface) so providers look symmetric with
 * what authored code sees. The `path` field on `readFile`/`writeFile`
 * here is the **already-resolved** path: the public-surface builder
 * calls `resolvePath` before delegating.
 */
export interface InternalSandboxSession extends Pick<
  AiSdkSandbox,
  "spawn" | "readFile" | "writeFile"
> {
  /** Removes an already-resolved path from the provider filesystem. */
  removePath(options: SandboxRemovePathOptions): Promise<void>;
  /** Translates a user-facing path to the provider's native path. */
  resolvePath(path: string): string;
}
