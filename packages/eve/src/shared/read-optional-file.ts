import { readFile } from "node:fs/promises";

import { isErrnoCode } from "#shared/guards.js";

/** Read a UTF-8 file, returning `undefined` when it does not exist. */
export async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}
