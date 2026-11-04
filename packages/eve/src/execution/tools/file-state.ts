import type { AlsContext } from "#context/container.js";
import { ReadFileStateKey } from "#context/keys.js";
import { sha256Hex } from "#shared/digest.js";
import { utf8ByteLength } from "#shared/bytes.js";
import { normalizePosix } from "#platform/posix-path.js";

// Read-file stamps track the last-known content for stale-write detection.

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
  return normalizePosix(path);
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
  const hash = sha256Hex(input.content);
  return {
    byteLength: utf8ByteLength(input.content),
    contentHash: hash,
    filePath: input.filePath,
  };
}

/**
 * Persists one read-file stamp into the durable context state.
 *
 * Centralizes the context read-update-write so the read and write file tools
 * do not duplicate the state mutation pattern.
 */
export function setReadFileStamp(ctx: AlsContext, targetKey: string, stamp: ReadFileStamp): void {
  const state = ctx.ensure(ReadFileStateKey, () => ({ byTarget: {} }));
  ctx.set(ReadFileStateKey, {
    byTarget: { ...state.byTarget, [targetKey]: stamp },
  });
}
