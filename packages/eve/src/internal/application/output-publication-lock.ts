import { watch } from "node:fs";
import { mkdir, readdir, rm, stat, utimes } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  removeOutputPublicationBackups,
  rollbackOutputPublication,
} from "#internal/application/output-publication-artifacts.js";
import {
  readOutputPublicationJournal,
  readRecoveryLeaseJournal,
  resolveJournalFilePath,
  type OutputPublicationJournal,
  type RecoveryLeaseJournal,
  writeOutputPublicationJournal,
  writeRecoveryLeaseJournal,
} from "#internal/application/output-publication-journal.js";
import { isErrnoCode } from "#shared/guards.js";
import { pathExists } from "#shared/path-exists.js";
import { renameWithTransientBusyRetry } from "#shared/rename-with-retry.js";

const PUBLICATION_LOCK_TIMEOUT_MS = 60_000;
const INCOMPLETE_LOCK_STALE_MS = 5_000;
const PUBLICATION_JOURNAL_HEARTBEAT_MS = 1_000;
const ACTIVE_JOURNAL_STALE_MS = 15_000;

interface RecoveryLease {
  complete(): Promise<void>;
  release(): Promise<void>;
}

export function resolveOutputPublicationLockPath(appRoot: string): string {
  return join(resolve(appRoot), ".eve", "locks", "output-publication.lock");
}

/**
 * Keeps a held lock's (or lease's) journal mtime fresh while its owner works.
 * Liveness cannot rest on `process.kill(pid, 0)` alone — journals survive
 * reboots, so a recycled pid (or an unrelated process answering `EPERM`)
 * would make a dead owner look alive forever. Returns a stop function.
 */
export function startPublicationJournalHeartbeat(journalDirectoryPath: string): () => void {
  const journalFilePath = resolveJournalFilePath(journalDirectoryPath);
  const heartbeat = setInterval(() => {
    const now = new Date();
    void utimes(journalFilePath, now, now).catch(() => undefined);
  }, PUBLICATION_JOURNAL_HEARTBEAT_MS);
  heartbeat.unref();
  return () => {
    clearInterval(heartbeat);
  };
}

export async function acquireOutputPublicationLock(
  lockPath: string,
  journal: OutputPublicationJournal,
  onContention: () => Promise<void>,
): Promise<() => Promise<void>> {
  const deadline = Date.now() + PUBLICATION_LOCK_TIMEOUT_MS;
  const recoveryPath = `${lockPath}.recovery`;
  await mkdir(dirname(lockPath), { recursive: true });

  for (;;) {
    if (await pathExists(recoveryPath)) {
      await onContention();
      if (await recoverStalePublication(lockPath, recoveryPath, journal)) {
        continue;
      }
      await waitForPublicationLockChange(lockPath, deadline);
      continue;
    }

    try {
      await mkdir(lockPath);
      if (await pathExists(recoveryPath)) {
        await rm(lockPath, { force: true, recursive: true });
        await waitForPublicationLockChange(lockPath, deadline);
        continue;
      }
      try {
        await writeOutputPublicationJournal(lockPath, journal);
      } catch (error) {
        await rm(lockPath, { force: true, recursive: true });
        throw error;
      }
      return async () => {
        const currentJournal = await readOutputPublicationJournal(lockPath);
        if (currentJournal?.token !== journal.token) {
          return;
        }
        const releasedPath = `${lockPath}.released-${journal.token}`;
        try {
          await renameWithTransientBusyRetry(lockPath, releasedPath);
        } catch (error) {
          if (isErrnoCode(error, "ENOENT")) {
            return;
          }
          throw error;
        }
        await rm(releasedPath, { force: true, recursive: true });
      };
    } catch (error) {
      if (!isErrnoCode(error, "EEXIST")) {
        throw error;
      }
    }

    await onContention();
    if (await recoverStalePublication(lockPath, recoveryPath, journal)) {
      continue;
    }
    await waitForPublicationLockChange(lockPath, deadline);
  }
}

async function recoverStalePublication(
  lockPath: string,
  recoveryPath: string,
  recoveryJournal: OutputPublicationJournal,
): Promise<boolean> {
  const releaseRecoveryLease = await acquireRecoveryLease(recoveryPath, recoveryJournal.token);
  if (releaseRecoveryLease === undefined) {
    return false;
  }

  const stopLeaseHeartbeat = startPublicationJournalHeartbeat(join(recoveryPath, "lease"));
  let preserveRecovery = false;
  try {
    const existingJournal = await readOutputPublicationJournal(lockPath);
    if (
      existingJournal !== undefined &&
      existingJournal.liveness === "active" &&
      isProcessAlive(existingJournal.pid) &&
      !(await isJournalStale(lockPath))
    ) {
      return false;
    }
    if (existingJournal === undefined && !(await isPathStale(lockPath))) {
      return false;
    }

    if (await pathExists(lockPath)) {
      const recoveringJournalPath = join(recoveryPath, `owner-${recoveryJournal.token}`);
      try {
        await renameWithTransientBusyRetry(lockPath, recoveringJournalPath);
        preserveRecovery = true;
      } catch (error) {
        if (!isErrnoCode(error, "ENOENT")) {
          throw error;
        }
      }
    }

    const entries = await readdir(recoveryPath, { withFileTypes: true });
    preserveRecovery = entries.some(
      (entry) => entry.isDirectory() && entry.name.startsWith("owner-"),
    );
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("owner-")) {
        continue;
      }
      await finishInterruptedPublication(join(recoveryPath, entry.name));
    }
    preserveRecovery = false;
    return true;
  } finally {
    stopLeaseHeartbeat();
    if (preserveRecovery) {
      await releaseRecoveryLease.release();
    } else {
      await releaseRecoveryLease.complete();
    }
  }
}

async function acquireRecoveryLease(
  recoveryPath: string,
  token: string,
): Promise<RecoveryLease | undefined> {
  const leasePath = join(recoveryPath, "lease");
  const leaseJournal: RecoveryLeaseJournal = { pid: process.pid, token };
  await mkdir(recoveryPath, { recursive: true });

  for (;;) {
    try {
      await mkdir(leasePath);
      try {
        await writeRecoveryLeaseJournal(leasePath, leaseJournal);
      } catch (error) {
        await rm(leasePath, { force: true, recursive: true });
        throw error;
      }
      return {
        async complete() {
          const currentJournal = await readRecoveryLeaseJournal(leasePath);
          if (currentJournal?.token !== token) {
            return;
          }
          const releasedPath = `${recoveryPath}.released-${token}`;
          try {
            await renameWithTransientBusyRetry(recoveryPath, releasedPath);
          } catch (error) {
            if (isErrnoCode(error, "ENOENT")) {
              return;
            }
            throw error;
          }
          await rm(releasedPath, { force: true, recursive: true });
        },
        async release() {
          const currentJournal = await readRecoveryLeaseJournal(leasePath);
          if (currentJournal?.token !== token) {
            return;
          }
          const releasedPath = `${leasePath}.released-${token}`;
          try {
            await renameWithTransientBusyRetry(leasePath, releasedPath);
          } catch (error) {
            if (isErrnoCode(error, "ENOENT")) {
              return;
            }
            throw error;
          }
          await rm(releasedPath, { force: true, recursive: true });
        },
      };
    } catch (error) {
      // ENOENT: a concurrent recoverer completed and renamed the recovery
      // directory away, so recovery is done — report contention, not failure.
      if (isErrnoCode(error, "ENOENT")) {
        return undefined;
      }
      if (!isErrnoCode(error, "EEXIST")) {
        throw error;
      }
    }

    const currentJournal = await readRecoveryLeaseJournal(leasePath);
    if (
      currentJournal !== undefined &&
      isProcessAlive(currentJournal.pid) &&
      !(await isJournalStale(leasePath))
    ) {
      return undefined;
    }
    if (currentJournal === undefined && !(await isPathStale(leasePath))) {
      return undefined;
    }

    const staleLeasePath = `${leasePath}.stale-${token}`;
    try {
      await renameWithTransientBusyRetry(leasePath, staleLeasePath);
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) {
        continue;
      }
      throw error;
    }
    await rm(staleLeasePath, { force: true, recursive: true });
  }
}

/**
 * Recovery is driven entirely by the stale journal's own recorded paths: the
 * interrupted publication may have targeted a different output directory than
 * the recovering build (`.vercel/output` vs `.output`), and refusing to touch
 * it would wedge every later publication behind the retained recovery dir.
 */
async function finishInterruptedPublication(journalPath: string): Promise<void> {
  const staleJournal = await readOutputPublicationJournal(journalPath);
  if (staleJournal === undefined || !hasTokenDerivedBackupPaths(staleJournal)) {
    await rm(journalPath, { force: true, recursive: true });
    return;
  }
  if (staleJournal.phase === "committed") {
    await removeOutputPublicationBackups(staleJournal);
  } else {
    await rollbackOutputPublication(staleJournal);
  }
  await removePublicationScratchDirectory(staleJournal);
  await rm(journalPath, { force: true, recursive: true });
}

/**
 * Backup paths that do not match the token derivation mean the journal is
 * corrupt or tampered with; discard it without renaming anything it names.
 */
function hasTokenDerivedBackupPaths(journal: OutputPublicationJournal): boolean {
  return (
    journal.outputBackupPath === `${journal.finalOutputDir}.eve-backup-${journal.token}` &&
    journal.summaryBackupPath === `${journal.finalSummaryPath}.eve-backup-${journal.token}`
  );
}

// The scratch directory is the failed build's preserved workspace; removing
// it after recovery is what keeps `.eve/builds` from accumulating orphans.
// The containment check stops a forged journal from deleting arbitrary paths.
async function removePublicationScratchDirectory(journal: OutputPublicationJournal): Promise<void> {
  const relativeStagedPath = relative(journal.scratchDir, journal.stagedOutputDir);
  if (
    relativeStagedPath === "" ||
    relativeStagedPath.startsWith("..") ||
    isAbsolute(relativeStagedPath)
  ) {
    return;
  }
  await rm(journal.scratchDir, { force: true, recursive: true });
}

async function waitForPublicationLockChange(lockPath: string, deadline: number): Promise<void> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw new Error(
      `Timed out waiting ${PUBLICATION_LOCK_TIMEOUT_MS}ms to publish completed build output.`,
    );
  }

  const locksDirectory = dirname(lockPath);
  const watchedPrefix = basename(lockPath);
  const initialState = await readPublicationLockState(lockPath);
  await new Promise<void>((resolvePromise, reject) => {
    let settled = false;
    const wakeAfterMs = Math.min(remainingMs, INCOMPLETE_LOCK_STALE_MS);
    const deadlineTimer = setTimeout(settleResolve, wakeAfterMs);
    const watcher = watch(locksDirectory, (eventType, filename) => {
      if (
        eventType === "rename" &&
        (filename === null || filename.toString().startsWith(watchedPrefix))
      ) {
        settleResolve();
      }
    });

    function cleanup() {
      clearTimeout(deadlineTimer);
      watcher.close();
    }
    function settleResolve() {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolvePromise();
    }
    function settleReject(error: unknown) {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    }

    watcher.once("error", settleReject);
    void Promise.all([
      readPublicationLockState(lockPath),
      pathExists(lockPath),
      pathExists(`${lockPath}.recovery`),
    ]).then(([nextState, lockExists, recoveryExists]) => {
      if ((!lockExists && !recoveryExists) || nextState !== initialState) {
        settleResolve();
      }
    }, settleReject);
  });
}

async function readPublicationLockState(lockPath: string): Promise<string> {
  const recoveryPath = `${lockPath}.recovery`;
  const [lockJournal, recoveryJournal, lockExists, recoveryExists] = await Promise.all([
    readOutputPublicationJournal(lockPath),
    readRecoveryLeaseJournal(join(recoveryPath, "lease")),
    pathExists(lockPath),
    pathExists(recoveryPath),
  ]);
  return JSON.stringify({
    lockExists,
    lockToken: lockJournal?.token,
    recoveryExists,
    recoveryToken: recoveryJournal?.token,
  });
}

async function isPathStale(path: string): Promise<boolean> {
  try {
    return Date.now() - (await stat(path)).mtimeMs >= INCOMPLETE_LOCK_STALE_MS;
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      return true;
    }
    throw error;
  }
}

async function isJournalStale(journalDirectoryPath: string): Promise<boolean> {
  try {
    const journalStats = await stat(resolveJournalFilePath(journalDirectoryPath));
    return Date.now() - journalStats.mtimeMs >= ACTIVE_JOURNAL_STALE_MS;
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      return true;
    }
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrnoCode(error, "ESRCH");
  }
}
