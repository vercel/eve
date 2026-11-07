import { contextStorage, loadContext } from "#context/container.js";
import {
  buildReadFileTargetKey,
  createReadFileStamp,
  normalizeModelPath,
  type ReadFileState,
  setReadFileStamp,
} from "#execution/tools/file-state.js";
import { ReadFileStateKey } from "#context/keys.js";
import { resolveAbsoluteFilePath } from "#execution/sandbox/require-sandbox.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

// ---------------------------------------------------------------------------
// Input / result shapes
// ---------------------------------------------------------------------------

/**
 * Typed input accepted by {@link executeWriteFileOnSandbox}.
 */
export interface WriteFileInput {
  readonly content: string;
  readonly filePath: string;
}

/**
 * Structured result returned from {@link executeWriteFileOnSandbox}.
 */
export interface WriteFileResult {
  readonly existed: boolean;
  readonly path: string;
}

/**
 * Keeps `write_file`'s read record current after another tool in the session
 * rewrites a file, so that change is not reported as a stale read. `before`
 * and `after` are the file's text as `readTextFile` decodes it. The record
 * moves only when it matches `before`: a file the session never read stays
 * unread, and a change made since the last read still fails the next write.
 * Outside a session this does nothing.
 */
export function refreshReadFileStamp(filePath: string, before: string, after: string): void {
  const ctx = contextStorage.getStore();
  if (ctx === undefined) return;
  const normalizedPath = normalizeModelPath(filePath);
  const targetKey = buildReadFileTargetKey(normalizedPath);
  const stored = ctx.get(ReadFileStateKey)?.byTarget[targetKey];
  const previous = createReadFileStamp({ content: before, filePath: normalizedPath });
  if (
    stored === undefined ||
    stored.contentHash !== previous.contentHash ||
    stored.byteLength !== previous.byteLength
  ) {
    return;
  }
  setReadFileStamp(
    ctx,
    targetKey,
    createReadFileStamp({ content: after, filePath: normalizedPath }),
  );
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * Writes one text file to the sandbox with read-before-write
 * enforcement and stale-read detection for existing files.
 *
 * Used by the framework `write_file` tool and authored wrappers around its
 * exported definition.
 */
export async function executeWriteFileOnSandbox(
  sandbox: SandboxSession,
  args: WriteFileInput,
): Promise<WriteFileResult> {
  const { filePath, content } = args;

  const resolvedPath = await resolveAbsoluteFilePath(sandbox, filePath);
  const ctx = loadContext();
  const normalizedPath = normalizeModelPath(resolvedPath);
  const targetKey = buildReadFileTargetKey(normalizedPath);

  // ── Read current file ───────────────────────────────────────────────
  // The full read is required even for new-file detection because
  // stale-write detection hashes the current content. This is a known
  // cost: the entire file is read and hashed before every write. A
  // separate `exists()` primitive would avoid this for new files but
  // would require a sandbox session API change.
  const currentContent = await sandbox.readTextFile({ path: resolvedPath });

  if (currentContent === null) {
    // ── File does not exist — write immediately, no prior read needed ──
    await sandbox.writeTextFile({ content, path: resolvedPath });

    const freshStamp = createReadFileStamp({
      content,
      filePath: normalizedPath,
    });

    setReadFileStamp(ctx, targetKey, freshStamp);

    return { existed: false, path: normalizedPath };
  }

  // ── File exists — enforce read-before-write ─────────────────────────
  const state = ctx.ensure(ReadFileStateKey, (): ReadFileState => ({ byTarget: {} }));
  const storedStamp = state.byTarget[targetKey];

  if (storedStamp === undefined) {
    throw new Error(
      `You must read file ${filePath} before overwriting it. Use the read_file tool first.`,
    );
  }

  // ── Stale-read detection ────────────────────────────────────────────
  const currentStamp = createReadFileStamp({
    content: currentContent,
    filePath: normalizedPath,
  });

  if (
    currentStamp.contentHash !== storedStamp.contentHash ||
    currentStamp.byteLength !== storedStamp.byteLength
  ) {
    throw new Error(
      `File ${filePath} has been modified since it was last read. ` +
        "Please read the file again before modifying it.",
    );
  }

  // ── Write and refresh stamp ─────────────────────────────────────────
  await sandbox.writeTextFile({ content, path: resolvedPath });

  const freshStamp = createReadFileStamp({
    content,
    filePath: normalizedPath,
  });

  setReadFileStamp(ctx, targetKey, freshStamp);

  return { existed: true, path: normalizedPath };
}
