import { createHash } from "node:crypto";
import { posix } from "node:path";

import { type AlsContext, loadContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";

// ---------------------------------------------------------------------------
// Read-file stamp — tracks the last-known content of a file for stale-write
// detection.
// ---------------------------------------------------------------------------

/**
 * Per-file fingerprint stored after a successful `read_file` call. Used by
 * `write_file` to detect stale overwrites and enforce read-before-write.
 */
export interface ReadFileStamp {
  readonly byteLength: number;
  readonly contentHash: string;
  readonly filePath: string;
}

/**
 * Durable session state holding read-file stamps keyed by normalized
 * absolute path.
 */
export interface ReadFileState {
  readonly byTarget: Readonly<Record<string, ReadFileStamp>>;
}

/**
 * Durable context key for read-file stamps.
 */
export const ReadFileStateKey = new ContextKey<ReadFileState>("eve.readFile");

// ---------------------------------------------------------------------------
// Path normalization
// ---------------------------------------------------------------------------

/**
 * Normalizes an absolute model-facing path by collapsing dot segments and
 * normalizing separators. The path must already be absolute — call
 * {@link normalizeModelPath} only after validating that the input starts
 * with `/`.
 *
 * Examples:
 * - `/workspace/./foo.ts`  → `/workspace/foo.ts`
 * - `/tmp/project/../project/foo.ts` → `/tmp/project/foo.ts`
 */
export function normalizeModelPath(path: string): string {
  return posix.normalize(path);
}

/**
 * Builds the durable state key used to index a read-file stamp.
 *
 * Callers are expected to pass an already-normalized path from
 * {@link normalizeModelPath}. This function does not re-normalize.
 */
export function buildReadFileTargetKey(normalizedPath: string): string {
  return normalizedPath;
}

// ---------------------------------------------------------------------------
// Content fingerprinting
// ---------------------------------------------------------------------------

/**
 * Creates a read-file stamp from file content. The stamp records a SHA-256
 * hash and UTF-8 byte length so `write_file` can detect external
 * modifications without filesystem metadata.
 */
export function createReadFileStamp(input: { content: string; filePath: string }): ReadFileStamp {
  const hash = createHash("sha256").update(input.content, "utf8").digest("hex");
  return {
    byteLength: Buffer.byteLength(input.content, "utf8"),
    contentHash: hash,
    filePath: input.filePath,
  };
}

/**
 * Persists one read-file stamp into the durable context state.
 *
 * Centralizes the context read-update-write so callers in `read-file-tool`
 * and `write-file-tool` do not duplicate the state mutation pattern.
 */
export function setReadFileStamp(ctx: AlsContext, targetKey: string, stamp: ReadFileStamp): void {
  const state = ctx.ensure(ReadFileStateKey, () => ({ byTarget: {} }));
  ctx.set(ReadFileStateKey, {
    byTarget: { ...state.byTarget, [targetKey]: stamp },
  });
}

// ---------------------------------------------------------------------------
// Compaction reset
// ---------------------------------------------------------------------------

/**
 * Clears all read-file stamps from the context. The framework calls this on
 * context compaction so a write afterward must re-read the file whose read
 * evidence was summarized out of history.
 */
export function clearReadFileState(): void {
  loadContext().set(ReadFileStateKey, { byTarget: {} });
}
