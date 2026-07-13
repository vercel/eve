import { rename, writeFile } from "node:fs/promises";

/**
 * Writes `contents` so concurrent readers always observe either the old or
 * the new file, never a truncated intermediate: a plain `writeFile` truncates
 * first and streams bytes, while a sibling temp file plus POSIX-atomic
 * `rename` rules that window out.
 */
export async function atomicWriteFile(
  targetPath: string,
  contents: string | Buffer | Uint8Array,
): Promise<void> {
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  await writeFile(tmpPath, contents);
  await rename(tmpPath, targetPath);
}
