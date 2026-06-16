import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveInstalledPackageInfo } from "#internal/application/package.js";

const EVE_CACHE_METADATA_FILE = "eve-cache.json";

/**
 * Clears one eve-owned cache directory when its recorded eve version is missing
 * or differs from the currently installed package version.
 */
export async function prepareEveVersionedCacheDirectory(directoryPath: string): Promise<void> {
  const cachedEveVersion = await readEveCacheVersion(directoryPath);
  const eveVersion = resolveInstalledPackageInfo().version;

  if (cachedEveVersion !== null && cachedEveVersion === eveVersion) {
    return;
  }

  await rm(directoryPath, {
    force: true,
    recursive: true,
  });
}

/**
 * Writes the current installed eve version into one eve-owned cache directory.
 */
export async function writeEveVersionedCacheMetadata(directoryPath: string): Promise<void> {
  await mkdir(directoryPath, {
    recursive: true,
  });
  await writeFile(
    join(directoryPath, EVE_CACHE_METADATA_FILE),
    `${JSON.stringify(
      {
        eveVersion: resolveInstalledPackageInfo().version,
      },
      null,
      2,
    )}\n`,
  );
}

async function readEveCacheVersion(directoryPath: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(
      await readFile(join(directoryPath, EVE_CACHE_METADATA_FILE), "utf8"),
    ) as {
      eveVersion?: unknown;
    };
    return typeof parsed.eveVersion === "string" ? parsed.eveVersion : null;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }

    return null;
  }
}
