import { rename } from "node:fs/promises";

import { isErrnoCode } from "#shared/guards.js";

const TRANSIENT_RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80, 160, 320, 640];

/**
 * Renames a path atomically, retrying the transient busy-handle errors that
 * Windows can report while another process briefly has either path open.
 */
export async function renameWithTransientBusyRetry(
  sourcePath: string,
  destinationPath: string,
): Promise<void> {
  for (const delayMs of TRANSIENT_RENAME_RETRY_DELAYS_MS) {
    try {
      await rename(sourcePath, destinationPath);
      return;
    } catch (error) {
      if (!isTransientRenameError(error)) {
        throw error;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
    }
  }
  await rename(sourcePath, destinationPath);
}

function isTransientRenameError(error: unknown): boolean {
  return isErrnoCode(error, "EPERM") || isErrnoCode(error, "EACCES") || isErrnoCode(error, "EBUSY");
}
