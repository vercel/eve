import { rename, rm, writeFile } from "node:fs/promises";

const REPLACE_RETRY_DELAYS_MS = [10, 20, 40, 80, 160, 320, 640];

/**
 * Writes `contents` so concurrent readers always observe either the old or
 * the new file, never a truncated intermediate: a plain `writeFile` truncates
 * first and streams bytes, while a sibling temp file plus POSIX-atomic
 * `rename` rules that window out.
 *
 * Windows refuses to replace a file while another handle is open on it
 * (concurrent readers, `utimes` heartbeats, antivirus scans), surfacing as
 * `EPERM`/`EACCES`, so the replace is retried briefly before giving up.
 */
export async function atomicWriteFile(
  targetPath: string,
  contents: string | Buffer | Uint8Array,
): Promise<void> {
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  await writeFile(tmpPath, contents);
  try {
    await renameReplacingBusyTarget(tmpPath, targetPath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function renameReplacingBusyTarget(fromPath: string, toPath: string): Promise<void> {
  for (const delayMs of REPLACE_RETRY_DELAYS_MS) {
    try {
      await rename(fromPath, toPath);
      return;
    } catch (error) {
      if (!isBusyTargetError(error)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  await rename(fromPath, toPath);
}

function isBusyTargetError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")
  );
}
