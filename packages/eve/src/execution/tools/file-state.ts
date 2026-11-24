import type { AlsContext } from "#context/container.js";
import { ReadFileStateKey } from "#context/keys.js";
import { sha256Hex } from "#shared/digest.js";
import { utf8ByteLength } from "#shared/bytes.js";
import { normalizePosix } from "#runtime-env/posix-path.js";

export interface ReadFileStamp {
  readonly byteLength: number;
  readonly contentHash: string;
  readonly filePath: string;
}

export interface ReadFileState {
  readonly byTarget: Readonly<Record<string, ReadFileStamp>>;
}

export function normalizeModelPath(path: string): string {
  return normalizePosix(path);
}

export function buildReadFileTargetKey(normalizedPath: string): string {
  return normalizedPath;
}

export function createReadFileStamp(input: { content: string; filePath: string }): ReadFileStamp {
  const hash = sha256Hex(input.content);
  return {
    byteLength: utf8ByteLength(input.content),
    contentHash: hash,
    filePath: input.filePath,
  };
}

export function setReadFileStamp(ctx: AlsContext, targetKey: string, stamp: ReadFileStamp): void {
  const state = ctx.ensure(ReadFileStateKey, () => ({ byTarget: {} }));
  ctx.set(ReadFileStateKey, {
    byTarget: { ...state.byTarget, [targetKey]: stamp },
  });
}
