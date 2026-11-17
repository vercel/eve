import { contextStorage, loadContext } from "#context/container.js";
import {
  buildReadFileTargetKey,
  createReadFileStamp,
  normalizeModelPath,
  type ReadFileState,
  ReadFileStateKey,
  setReadFileStamp,
} from "#execution/tools/file-state.js";
import { resolveAbsoluteFilePath } from "#execution/sandbox/require-sandbox.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

export interface WriteFileInput {
  readonly content: string;
  readonly filePath: string;
}

export interface WriteFileResult {
  readonly existed: boolean;
  readonly path: string;
}

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

export async function executeWriteFileOnSandbox(
  sandbox: SandboxSession,
  args: WriteFileInput,
): Promise<WriteFileResult> {
  const { filePath, content } = args;

  const resolvedPath = await resolveAbsoluteFilePath(sandbox, filePath);
  const ctx = loadContext();
  const normalizedPath = normalizeModelPath(resolvedPath);
  const targetKey = buildReadFileTargetKey(normalizedPath);

  const currentContent = await sandbox.readTextFile({ path: resolvedPath });

  if (currentContent === null) {
    await sandbox.writeTextFile({ content, path: resolvedPath });

    const freshStamp = createReadFileStamp({
      content,
      filePath: normalizedPath,
    });

    setReadFileStamp(ctx, targetKey, freshStamp);

    return { existed: false, path: normalizedPath };
  }

  const state = ctx.ensure(ReadFileStateKey, (): ReadFileState => ({ byTarget: {} }));
  const storedStamp = state.byTarget[targetKey];

  if (storedStamp === undefined) {
    throw new Error(
      `You must read file ${filePath} before overwriting it. Use the read_file tool first.`,
    );
  }

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

  await sandbox.writeTextFile({ content, path: resolvedPath });

  const freshStamp = createReadFileStamp({
    content,
    filePath: normalizedPath,
  });

  setReadFileStamp(ctx, targetKey, freshStamp);

  return { existed: true, path: normalizedPath };
}
