import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

import { resolveSandboxCacheDirectory } from "#internal/application/paths.js";

const LOCK_POLL_MS = 250;
const LOCK_TIMEOUT_MS = 15 * 60 * 1000;
// Must stay strictly below LOCK_TIMEOUT_MS so a fresh orphan lock (recent mtime)
// is reclaimed by the mtime fallback before any waiter gives up and throws.
// Same-host dead holders are reclaimed immediately by the pid-liveness check
// below, regardless of this window; this only bounds the hostname-less /
// cross-host fallback case.
const STALE_LOCK_MS = 10 * 60 * 1000;

interface PrewarmLockOwner {
  readonly createdAt: string;
  readonly hostname?: string;
  readonly pid?: number;
}

export interface SandboxTemplatePrewarmLockInput {
  readonly appRoot: string;
  readonly backendName: string;
  readonly log?: (message: string) => void;
  readonly templateKey: string;
}

export async function waitForSandboxTemplatePrewarmLock(
  input: SandboxTemplatePrewarmLockInput,
): Promise<void> {
  await waitForLockRelease(resolveSandboxTemplatePrewarmLockPath(input), input.log);
}

export async function withSandboxTemplatePrewarmLock<T>(
  input: SandboxTemplatePrewarmLockInput,
  callback: () => Promise<T>,
): Promise<T> {
  const lockPath = resolveSandboxTemplatePrewarmLockPath(input);
  await acquireLock(lockPath);
  try {
    return await callback();
  } finally {
    await rm(lockPath, { force: true, recursive: true }).catch(() => {});
  }
}

function resolveSandboxTemplatePrewarmLockPath(input: SandboxTemplatePrewarmLockInput): string {
  return join(
    resolveSandboxCacheDirectory(input.appRoot),
    "template-locks",
    input.backendName,
    `${input.templateKey}.lock`,
  );
}

async function acquireLock(lockPath: string): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    await mkdir(dirname(lockPath), { recursive: true });
    try {
      await mkdir(lockPath);
      await writeFile(
        join(lockPath, "owner.json"),
        `${JSON.stringify({
          createdAt: new Date().toISOString(),
          hostname: hostname(),
          pid: process.pid,
        } satisfies PrewarmLockOwner)}\n`,
      );
      return;
    } catch (error) {
      if (!isFileExistsError(error)) {
        throw error;
      }
      await waitForExistingLock(lockPath, startedAt, undefined);
    }
  }
}

async function waitForLockRelease(
  lockPath: string,
  log: ((message: string) => void) | undefined,
): Promise<void> {
  const startedAt = Date.now();
  let nextLogAt = startedAt + 10_000;
  for (;;) {
    try {
      await stat(lockPath);
    } catch (error) {
      if (isNotFoundError(error)) {
        return;
      }
      throw error;
    }
    const now = Date.now();
    if (log !== undefined && now >= nextLogAt) {
      const elapsedSeconds = Math.round((now - startedAt) / 1000);
      log(
        elapsedSeconds === 0
          ? "waiting for sandbox template prewarm to finish"
          : `waiting for sandbox template prewarm to finish (${elapsedSeconds}s elapsed)`,
      );
      nextLogAt = now + 10_000;
    }
    await waitForExistingLock(lockPath, startedAt, log);
  }
}

async function waitForExistingLock(
  lockPath: string,
  startedAt: number,
  log: ((message: string) => void) | undefined,
): Promise<void> {
  const lockStat = await stat(lockPath).catch((error: unknown) => {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  });
  if (lockStat === null) {
    return;
  }

  // Decide what to do based on the recorded owner's liveness. The prewarm holder
  // always runs on the same host as the waiter for the local/docker/microsandbox
  // backends, so a same-host pid-liveness check is sound. We only trust it when
  // owner.json records a matching hostname; older locks without a hostname (or
  // genuine cross-host holders) report "unknown" and fall back to the mtime
  // window below.
  const liveness = await getPrewarmLockHolderLiveness(lockPath);

  if (liveness === "dead") {
    // Holder process is gone -> reclaim immediately rather than waiting out the
    // mtime stale window.
    log?.("removing sandbox template prewarm lock held by a dead process");
    await rm(lockPath, { force: true, recursive: true }).catch(() => {});
    return;
  }

  if (liveness === "unknown") {
    // No trustworthy pid signal: fall back to the mtime window. The lock's mtime
    // is set once at acquire time and never refreshed, so this also reclaims a
    // hostname-less orphan whose recent mtime would otherwise block. (A genuine
    // long-running hostname-less holder is the only false-positive case; such
    // locks are transient after an upgrade adds the hostname field.)
    const lockAgeMs = Date.now() - lockStat.mtimeMs;
    if (lockAgeMs > STALE_LOCK_MS) {
      log?.("removing stale sandbox template prewarm lock");
      await rm(lockPath, { force: true, recursive: true }).catch(() => {});
      return;
    }
  }

  // liveness === "alive": respect the live holder and keep polling. Do NOT apply
  // the mtime window — the holder may legitimately run longer than STALE_LOCK_MS,
  // and reclaiming it would let two prewarms of the same template race. Overall
  // waiting is still bounded by LOCK_TIMEOUT_MS below.

  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs > LOCK_TIMEOUT_MS) {
    throw new Error(
      `Timed out waiting for sandbox template prewarm lock "${lockPath}" after ${LOCK_TIMEOUT_MS}ms.`,
    );
  }

  await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
}

type PrewarmLockLiveness = "alive" | "dead" | "unknown";

/**
 * Classifies the recorded lock owner's liveness:
 *   "dead"    - same-host owner (hostname matches), valid pid, process gone (ESRCH)
 *   "alive"   - same-host owner, valid pid, process exists (kill(0) ok, or EPERM)
 *   "unknown" - no owner / no hostname / hostname mismatch / non-positive pid /
 *               unreadable record. A pid is only meaningful on the host that
 *               recorded it, so anything we can't verify falls back to the mtime
 *               window in the caller.
 */
async function getPrewarmLockHolderLiveness(lockPath: string): Promise<PrewarmLockLiveness> {
  const owner = await readPrewarmLockOwner(lockPath);
  if (owner === null) {
    return "unknown";
  }
  if (owner.hostname === undefined || owner.hostname !== hostname()) {
    return "unknown";
  }
  if (typeof owner.pid !== "number" || !Number.isInteger(owner.pid) || owner.pid <= 0) {
    return "unknown";
  }
  try {
    // Signal 0 performs error checking without sending a signal.
    process.kill(owner.pid, 0);
    return "alive";
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) {
      // ESRCH: no such process -> the holder is gone. EPERM: the process exists
      // but is owned by another user -> treat as alive.
      return error.code === "ESRCH" ? "dead" : "alive";
    }
    // Unexpected error shape: don't assume dead.
    return "alive";
  }
}

async function readPrewarmLockOwner(lockPath: string): Promise<PrewarmLockOwner | null> {
  try {
    const contents = await readFile(join(lockPath, "owner.json"), "utf8");
    const parsed: unknown = JSON.parse(contents);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    return parsed as PrewarmLockOwner;
  } catch {
    return null;
  }
}

function isFileExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
