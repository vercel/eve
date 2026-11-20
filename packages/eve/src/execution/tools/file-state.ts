import { createHash } from "node:crypto";
import { posix } from "node:path";

import type { AlsContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";

export interface ReadFileStamp {
  readonly byteLength: number;
  readonly contentHash: string;
  readonly filePath: string;
}

export interface ReadFileState {
  readonly byTarget: Readonly<Record<string, ReadFileStamp>>;
}

export const ReadFileStateKey = new ContextKey<ReadFileState>("eve.readFile");

export function normalizeModelPath(path: string): string {
  return posix.normalize(path);
}

export function buildReadFileTargetKey(normalizedPath: string): string {
  return normalizedPath;
}

export function createReadFileStamp(input: { content: string; filePath: string }): ReadFileStamp {
  const hash = createHash("sha256").update(input.content, "utf8").digest("hex");
  return {
    byteLength: Buffer.byteLength(input.content, "utf8"),
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
