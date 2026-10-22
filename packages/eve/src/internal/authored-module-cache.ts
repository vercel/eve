import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

// Several processes (`eve dev` builds, `eve build`, `eve eval`) share a cache directory, so a
// file can only be pruned once no process has written or reused it for well past any compile.
const STALE_CACHE_FILE_AGE_MS = 3 * 24 * 60 * 60 * 1000;

const cacheDirectories = new Set<string>();

/**
 * Writes a content-addressed bundle into the authored-module cache, or marks an
 * existing one as recently used so {@link pruneAuthoredModuleCache} keeps it.
 */
export function writeAuthoredModuleCacheFile(
  directoryPath: string,
  fileName: string,
  code: string,
): string {
  cacheDirectories.add(directoryPath);
  const filePath = join(directoryPath, fileName);
  // Touch first and write only when missing: another load may be importing an existing file, and a
  // concurrent prune may delete a stale one between an existence check and its use.
  try {
    const now = new Date();
    utimesSync(filePath, now, now);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return filePath;
    mkdirSync(directoryPath, { recursive: true });
    writeFileSync(filePath, code);
  }
  return filePath;
}

/**
 * Best-effort removal of cached bundles that no process has written or reused
 * recently. Cache keys derive from bundle output, so every edit leaves the
 * previous bundles behind.
 */
export async function pruneAuthoredModuleCache(): Promise<void> {
  const cutoff = Date.now() - STALE_CACHE_FILE_AGE_MS;
  for (const directoryPath of cacheDirectories) {
    const fileNames = await readdir(directoryPath).catch(() => []);
    await Promise.all(
      fileNames
        .filter((fileName) => fileName.endsWith(".mjs"))
        .map(async (fileName) => {
          const filePath = join(directoryPath, fileName);
          try {
            if ((await stat(filePath)).mtimeMs < cutoff) await unlink(filePath);
          } catch {}
        }),
    );
  }
}
