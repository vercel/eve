import { stat } from "node:fs/promises";

import { isErrnoCode } from "#shared/guards.js";

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}
