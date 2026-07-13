import { watch } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import {
  removeOutputPublicationBackups,
  rollbackOutputPublication,
} from "#internal/application/output-publication-artifacts.js";
import {
  readOutputPublicationJournal,
  readRecoveryLeaseJournal,
  type OutputPublicationJournal,
  type RecoveryLeaseJournal,
  writeOutputPublicationJournal,
  writeRecoveryLeaseJournal,
} from "#internal/application/output-publication-journal.js";

const PUBLICATION_LOCK_TIMEOUT_MS = 60_000;
const INCOMPLETE_LOCK_STALE_MS = 5_000;

interface RecoveryLease {
  complete(): Promise<void>;
  release(): Promise<void>;
}

export function resolveOutputPublicationLockPath(appRoot: string): string {
  return join(resolve(appRoot), ".eve", "locks", "output-publication.lock");
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
          await rename(lockPath, releasedPath);
        } catch (error) {
          if (isNodeErrorWithCode(error, "ENOENT")) {
            return;
          }
          throw error;
        }
        await rm(releasedPath, { force: true, recursive: true });
      };
    } catch (error) {
      if (!isNodeErrorWithCode(error, "EEXIST")) {
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

  let preserveRecovery = false;
  try {
    const existingJournal = await readOutputPublicationJournal(lockPath);
    if (
      existingJournal !== undefined &&
      existingJournal.liveness === "active" &&
      isProcessAlive(existingJournal.pid)
    ) {
      return false;
    }
    if (existingJournal === undefined && !(await isPathStale(lockPath))) {
      return false;
    }

    if (await pathExists(lockPath)) {
      const recoveringJournalPath = join(recoveryPath, `owner-${recoveryJournal.token}`);
      try {
        await rename(lockPath, recoveringJournalPath);
        preserveRecovery = true;
      } catch (error) {
        if (!isNodeErrorWithCode(error, "ENOENT")) {
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
      await finishInterruptedPublication(join(recoveryPath, entry.name), recoveryJournal);
    }
    preserveRecovery = false;
    return true;
  } finally {
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
            await rename(recoveryPath, releasedPath);
          } catch (error) {
            if (isNodeErrorWithCode(error, "ENOENT")) {
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
            await rename(leasePath, releasedPath);
          } catch (error) {
            if (isNodeErrorWithCode(error, "ENOENT")) {
              return;
            }
            throw error;
          }
          await rm(releasedPath, { force: true, recursive: true });
        },
      };
    } catch (error) {
      if (!isNodeErrorWithCode(error, "EEXIST")) {
        throw error;
      }
    }

    const currentJournal = await readRecoveryLeaseJournal(leasePath);
    if (currentJournal !== undefined && isProcessAlive(currentJournal.pid)) {
      return undefined;
    }
    if (currentJournal === undefined && !(await isPathStale(leasePath))) {
      return undefined;
    }

    const staleLeasePath = `${leasePath}.stale-${token}`;
    try {
      await rename(leasePath, staleLeasePath);
    } catch (error) {
      if (isNodeErrorWithCode(error, "ENOENT")) {
        continue;
      }
      throw error;
    }
    await rm(staleLeasePath, { force: true, recursive: true });
  }
}

async function finishInterruptedPublication(
  journalPath: string,
  recoveryJournal: OutputPublicationJournal,
): Promise<void> {
  const staleJournal = await readOutputPublicationJournal(journalPath);
  if (staleJournal === undefined) {
    await rm(journalPath, { force: true, recursive: true });
    return;
  }
  assertMatchingPublicationTarget(staleJournal, recoveryJournal);
  if (staleJournal.phase === "committed") {
    await removeOutputPublicationBackups(staleJournal);
  } else {
    await rollbackOutputPublication(staleJournal);
  }
  await rm(journalPath, { force: true, recursive: true });
}

function assertMatchingPublicationTarget(
  staleJournal: OutputPublicationJournal,
  recoveryJournal: OutputPublicationJournal,
): void {
  if (
    staleJournal.finalOutputDir !== recoveryJournal.finalOutputDir ||
    staleJournal.finalSummaryPath !== recoveryJournal.finalSummaryPath ||
    staleJournal.outputBackupPath !==
      `${staleJournal.finalOutputDir}.eve-backup-${staleJournal.token}` ||
    staleJournal.summaryBackupPath !==
      `${staleJournal.finalSummaryPath}.eve-backup-${staleJournal.token}`
  ) {
    throw new Error("Refusing to recover a build publication for a different output target.");
  }
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
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return true;
    }
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeErrorWithCode(error, "ESRCH");
  }
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
