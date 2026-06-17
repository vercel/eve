import type { Experimental_SandboxSession as AiSdkSandbox } from "ai";

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
 * code that targets either surface uses identical signatures. `id` and
 * `resolvePath` are eve-specific extensions that the runtime relies on
 * for caching and `/workspace` path anchoring.
 *
 * Relative paths resolve from `/workspace`, the live working directory
 * for every backend. Absolute paths pass through unchanged.
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
   * Stable identifier for the backend session this handle wraps.
   *
   * Persists across reconnects to the same logical session: two calls
   * that resume the same underlying backend sandbox observe the same
   * `id`. Template sessions constructed during bootstrap expose the
   * template key; live sessions expose the session key assigned by the
   * runtime. Useful as a cache key for per-session state that must
   * outlive individual step executions.
   */
  readonly id: string;
  /**
   * Anchors a sandbox-relative path to `/workspace` and returns the
   * resulting absolute path.
   *
   * Relative paths resolve from `/workspace`; absolute paths pass through.
   * The read and write methods already apply this internally.
   */
  resolvePath(path: string): string;
  /**
   * Applies a firewall network policy to this live sandbox at run time,
   * for changing the policy *during* a turn (e.g. brokering a credential
   * resolved mid-turn, or tightening egress after fetching data). A
   * per-domain `transform` injects headers at the firewall so secrets
   * never enter the sandbox process. The policy takes effect from the time
   * the call resolves, so await it before the egress you want governed.
   *
   * When the policy is known at session start, prefer configuring it up
   * front in the sandbox backend factory or `onSession`'s `use()`. The
   * Docker backend honors only `"allow-all"` and `"deny-all"`;
   * the just-bash backend rejects this call entirely (its network policy
   * is fixed at sandbox creation and it runs no binaries to govern).
   */
  setNetworkPolicy(policy: SandboxNetworkPolicy): Promise<void>;
  /**
   * Removes one file or directory from the sandbox filesystem.
   *
   * Relative paths resolve from `/workspace`; absolute paths pass through.
   */
  removePath(options: SandboxRemovePathOptions): Promise<void>;
}

/**
 * Internal sandbox session, used to construct the public {@link SandboxSession}.
 *
 * Backend implementers only need to provide byte-oriented file I/O and
 * a `spawn` primitive; the public surface (binary and text variants,
 * line-range slicing, encoding handling, the `run` wrapper) is built on
 * top of these primitives by `buildSandboxSession`.
 *
 * Each method's signature mirrors its public counterpart (and the AI
 * SDK {@link AiSdkSandbox} surface) so backends look symmetric with
 * what authored code sees. The `path` field on `readFile`/`writeFile`
 * here is the **already-resolved** path: the public-surface builder
 * calls `resolvePath` before delegating.
 */
export interface InternalSandboxSession extends Pick<
  AiSdkSandbox,
  "spawn" | "readFile" | "writeFile"
> {
  /**
   * Stable identifier surfaced on the public {@link SandboxSession}.
   */
  readonly id: string;
  /** Removes an already-resolved path from the backend filesystem. */
  removePath(options: SandboxRemovePathOptions): Promise<void>;
  /** Translates a user-facing path to the backend's native path. */
  resolvePath(path: string): string;
}
