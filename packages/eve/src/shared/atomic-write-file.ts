import { rm, writeFile } from "node:fs/promises";

import { renameWithTransientBusyRetry } from "#shared/rename-with-retry.js";

export async function atomicWriteFile(
  targetPath: string,
  contents: string | Buffer | Uint8Array,
): Promise<void> {
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  await writeFile(tmpPath, contents);
  try {
    await renameWithTransientBusyRetry(tmpPath, targetPath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
