import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { resolveSandboxCacheDirectory } from "#internal/application/paths.js";

const LOCK_POLL_MS = 250;
const LOCK_TIMEOUT_MS = 15 * 60 * 1000;
const STALE_LOCK_MS = 30 * 60 * 1000;

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
        `${JSON.stringify({ createdAt: new Date().toISOString(), pid: process.pid })}\n`,
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

  const lockAgeMs = Date.now() - lockStat.mtimeMs;
  if (lockAgeMs > STALE_LOCK_MS) {
    log?.("removing stale sandbox template prewarm lock");
    await rm(lockPath, { force: true, recursive: true }).catch(() => {});
    return;
  }

  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs > LOCK_TIMEOUT_MS) {
    throw new Error(
      `Timed out waiting for sandbox template prewarm lock "${lockPath}" after ${LOCK_TIMEOUT_MS}ms.`,
    );
  }

  await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
}

function isFileExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
