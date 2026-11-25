import { contextStorage, loadContext } from "#context/container.js";
import {
  buildReadFileTargetKey,
  createReadFileStamp,
  normalizeModelPath,
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

  const existed = (await sandbox.readBinaryFile({ path: resolvedPath })) !== null;
  await sandbox.writeTextFile({ content, path: resolvedPath });

  const freshStamp = createReadFileStamp({
    content,
    filePath: normalizedPath,
  });

  setReadFileStamp(ctx, targetKey, freshStamp);

  return { existed, path: normalizedPath };
}
