import { mkdir, rm, stat, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";

import { isErrnoCode } from "#shared/guards.js";

const LOCK_HEARTBEAT_MS = 2_000;
// Several missed heartbeats mean the owner crashed or was killed mid-build.
const LOCK_STALE_MS = 30_000;
const LOCK_POLL_MS = 100;
const LOCK_TIMEOUT_MS = 10 * 60_000;

/** Path of the cross-process lock that serializes writes to one extension's build output. */
export function resolveExtensionBuildLockPath(packageRoot: string): string {
  return join(packageRoot, ".eve", "locks", "extension-build.lock");
}

/**
 * Runs `callback` while holding a cross-process lock scoped to one extension
 * package. Separate `eve build`, `eve dev`, `withEve`, and `eve extension
 * build` processes can build the same workspace extension, and publication
 * swaps the whole output directory, so concurrent builds must not overlap.
 */
export async function withExtensionBuildLock<T>(
  packageRoot: string,
  callback: () => Promise<T>,
): Promise<T> {
  const lockPath = resolveExtensionBuildLockPath(packageRoot);
  await acquireExtensionBuildLock(lockPath, packageRoot);
  const heartbeat = setInterval(() => {
    const now = new Date();
    void utimes(lockPath, now, now).catch(() => undefined);
  }, LOCK_HEARTBEAT_MS);
  heartbeat.unref();
  try {
    return await callback();
  } finally {
    clearInterval(heartbeat);
    await rm(lockPath, { force: true, recursive: true });
  }
}

async function acquireExtensionBuildLock(lockPath: string, packageRoot: string): Promise<void> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  await mkdir(dirname(lockPath), { recursive: true });
  for (;;) {
    try {
      await mkdir(lockPath);
      return;
    } catch (error) {
      if (!isErrnoCode(error, "EEXIST")) throw error;
    }

    // Two waiters that detect the same stale lock at once can both acquire it.
    // That needs a crashed owner plus a simultaneous takeover, so the rare
    // overlap is accepted over a recovery protocol.
    const heldSince = (await stat(lockPath).catch(() => undefined))?.mtimeMs;
    if (heldSince !== undefined && Date.now() - heldSince >= LOCK_STALE_MS) {
      await rm(lockPath, { force: true, recursive: true });
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${String(LOCK_TIMEOUT_MS / 60_000)} minutes waiting for another eve process to finish building the extension at ${packageRoot}. If no other build is running, delete ${lockPath} and retry.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
}
