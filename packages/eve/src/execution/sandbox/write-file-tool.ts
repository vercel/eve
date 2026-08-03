import { loadContext } from "#context/container.js";
import {
  buildReadFileTargetKey,
  createReadFileStamp,
  normalizeModelPath,
  type ReadFileState,
  ReadFileStateKey,
  setReadFileStamp,
} from "#runtime/framework-tools/file-state.js";
import { resolveSkillFilePathCandidates } from "#shared/skill-paths.js";
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

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * Writes one text file to the sandbox with read-before-write
 * enforcement and stale-read detection for existing files.
 *
 * Used by the framework `write_file` tool and by author tools
 * constructed via `defineWriteFileTool`.
 */
export async function executeWriteFileOnSandbox(
  sandbox: SandboxSession,
  args: WriteFileInput,
): Promise<WriteFileResult> {
  const { filePath, content } = args;

  const ctx = loadContext();

  // Resolve the skill-aware candidate list exactly as read_file does, so an
  // edit lands on the same file read_file served rather than a divergent shadow
  // copy under the other skill root. An existing file is written where it lives;
  // a new file is created at the first (home-first) candidate.
  const candidatePaths = await resolveSkillFilePathCandidates({ path: filePath, sandbox });
  for (const candidate of candidatePaths) {
    if (!candidate.startsWith("/")) {
      throw new Error(
        `filePath must be an absolute path. Received: "${filePath}". ` +
          "Use an absolute path such as /workspace/foo.ts or a path beginning with $HOME/.",
      );
    }
  }

  // ── Read current file ───────────────────────────────────────────────
  // The full read is required even for new-file detection because
  // stale-write detection hashes the current content. This is a known
  // cost: the entire file is read and hashed before every write. A
  // separate `exists()` primitive would avoid this for new files but
  // would require a sandbox session API change.
  let resolvedPath = candidatePaths[0]!;
  let currentContent: string | null = null;
  for (const candidate of candidatePaths) {
    const existing = await sandbox.readTextFile({ path: candidate });
    if (existing !== null) {
      resolvedPath = candidate;
      currentContent = existing;
      break;
    }
  }

  const normalizedPath = normalizeModelPath(resolvedPath);
  const targetKey = buildReadFileTargetKey(normalizedPath);

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
