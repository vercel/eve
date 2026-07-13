import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const PUBLICATION_LOCK_TIMEOUT_MS = 60_000;
const INCOMPLETE_LOCK_STALE_MS = 5_000;

type PublicationPhase = "acquired" | "prepared" | "backed-up" | "installed" | "committed";

interface OutputPublicationOwner {
  readonly finalOutputDir: string;
  readonly finalSummaryPath: string;
  hadOutput: boolean;
  hadSummary: boolean;
  readonly outputBackupPath: string;
  phase: PublicationPhase;
  pid: number;
  readonly stagedOutputDir: string;
  readonly stagedSummaryPath: string;
  readonly startedAt: string;
  readonly summaryBackupPath: string;
  readonly token: string;
}

interface RecoveryLeaseOwner {
  readonly pid: number;
  readonly startedAt: string;
  readonly token: string;
}

export async function publishApplicationBuildArtifacts(input: {
  readonly appRoot: string;
  readonly finalOutputDir: string;
  readonly finalSummaryPath: string;
  readonly stagedOutputDir: string;
  readonly stagedSummaryPath: string;
  readonly onAfterBackup?: () => Promise<void> | void;
  readonly onAfterOutputInstall?: () => Promise<void> | void;
  readonly onLockContention?: () => Promise<void> | void;
}): Promise<void> {
  await Promise.all([stat(input.stagedOutputDir), stat(input.stagedSummaryPath)]);

  const token = randomUUID();
  const lockPath = resolveOutputPublicationLockPath(input.appRoot);
  const owner: OutputPublicationOwner = {
    finalOutputDir: resolve(input.finalOutputDir),
    finalSummaryPath: resolve(input.finalSummaryPath),
    hadOutput: false,
    hadSummary: false,
    outputBackupPath: `${resolve(input.finalOutputDir)}.eve-backup-${token}`,
    phase: "acquired",
    pid: process.pid,
    stagedOutputDir: resolve(input.stagedOutputDir),
    stagedSummaryPath: resolve(input.stagedSummaryPath),
    startedAt: new Date().toISOString(),
    summaryBackupPath: `${resolve(input.finalSummaryPath)}.eve-backup-${token}`,
    token,
  };
  const release = await acquireOutputPublicationLock({
    lockPath,
    onContention: input.onLockContention,
    owner,
  });
  let committed = false;

  try {
    owner.hadOutput = await pathExists(owner.finalOutputDir);
    owner.hadSummary = await pathExists(owner.finalSummaryPath);
    owner.phase = "prepared";
    await writePublicationOwner(lockPath, owner);

    await Promise.all([
      mkdir(dirname(owner.finalOutputDir), { recursive: true }),
      mkdir(dirname(owner.finalSummaryPath), { recursive: true }),
    ]);
    if (owner.hadOutput) {
      await rename(owner.finalOutputDir, owner.outputBackupPath);
    }
    if (owner.hadSummary) {
      await rename(owner.finalSummaryPath, owner.summaryBackupPath);
    }
    owner.phase = "backed-up";
    await writePublicationOwner(lockPath, owner);
    await input.onAfterBackup?.();

    await rename(owner.stagedOutputDir, owner.finalOutputDir);
    await input.onAfterOutputInstall?.();
    await rename(owner.stagedSummaryPath, owner.finalSummaryPath);
    owner.phase = "installed";
    await writePublicationOwner(lockPath, owner);

    owner.phase = "committed";
    await writePublicationOwner(lockPath, owner);
    committed = true;
  } catch (error) {
    try {
      await rollbackOutputPublication(owner);
    } catch (rollbackError) {
      owner.pid = 0;
      await writePublicationOwner(lockPath, owner).catch(() => undefined);
      throw new AggregateError(
        [error, rollbackError],
        "Build output publication failed and could not fully restore the previous output.",
        { cause: error },
      );
    }
    throw error;
  } finally {
    if (committed || owner.pid !== 0) {
      await release();
    }
  }

  await removePublicationBackups(owner).catch(() => undefined);
}

export function resolveOutputPublicationLockPath(appRoot: string): string {
  return join(resolve(appRoot), ".eve", "locks", "output-publication.lock");
}

async function acquireOutputPublicationLock(input: {
  readonly lockPath: string;
  readonly onContention?: () => Promise<void> | void;
  readonly owner: OutputPublicationOwner;
}): Promise<() => Promise<void>> {
  const deadline = Date.now() + PUBLICATION_LOCK_TIMEOUT_MS;
  const recoveryPath = `${input.lockPath}.recovery`;
  await mkdir(dirname(input.lockPath), { recursive: true });

  for (;;) {
    if (await pathExists(recoveryPath)) {
      await input.onContention?.();
      if (await recoverStalePublication(input.lockPath, recoveryPath, input.owner)) {
        continue;
      }
      await waitForPublicationLockChange(input.lockPath, deadline);
      continue;
    }

    try {
      await mkdir(input.lockPath);
      if (await pathExists(recoveryPath)) {
        await rm(input.lockPath, { force: true, recursive: true });
        await waitForPublicationLockChange(input.lockPath, deadline);
        continue;
      }
      try {
        await writePublicationOwner(input.lockPath, input.owner);
      } catch (error) {
        await rm(input.lockPath, { force: true, recursive: true });
        throw error;
      }
      return async () => {
        const currentOwner = await readPublicationOwner(input.lockPath);
        if (currentOwner?.token !== input.owner.token) {
          return;
        }
        const releasedPath = `${input.lockPath}.released-${input.owner.token}`;
        try {
          await rename(input.lockPath, releasedPath);
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

    await input.onContention?.();
    if (await recoverStalePublication(input.lockPath, recoveryPath, input.owner)) {
      continue;
    }
    await waitForPublicationLockChange(input.lockPath, deadline);
  }
}

async function recoverStalePublication(
  lockPath: string,
  recoveryPath: string,
  recoveryOwner: OutputPublicationOwner,
): Promise<boolean> {
  const releaseRecoveryLease = await acquireRecoveryLease(recoveryPath, recoveryOwner.token);
  if (releaseRecoveryLease === undefined) {
    return false;
  }

  try {
    const existingOwner = await readPublicationOwner(lockPath);
    if (existingOwner !== undefined && isProcessAlive(existingOwner.pid)) {
      return false;
    }
    if (existingOwner === undefined && !(await isPathStale(lockPath))) {
      return false;
    }

    if (await pathExists(lockPath)) {
      const recoveringOwnerPath = join(recoveryPath, `owner-${recoveryOwner.token}`);
      try {
        await rename(lockPath, recoveringOwnerPath);
      } catch (error) {
        if (!isNodeErrorWithCode(error, "ENOENT")) {
          throw error;
        }
      }
    }

    const entries = await readdir(recoveryPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("owner-")) {
        continue;
      }
      await finishInterruptedPublication(join(recoveryPath, entry.name), recoveryOwner);
    }
    return true;
  } finally {
    await releaseRecoveryLease();
  }
}

async function acquireRecoveryLease(
  recoveryPath: string,
  token: string,
): Promise<(() => Promise<void>) | undefined> {
  const leasePath = join(recoveryPath, "lease");
  const leaseOwner: RecoveryLeaseOwner = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    token,
  };
  await mkdir(recoveryPath, { recursive: true });

  for (;;) {
    try {
      await mkdir(leasePath);
      try {
        await writeRecoveryLeaseOwner(leasePath, leaseOwner);
      } catch (error) {
        await rm(leasePath, { force: true, recursive: true });
        throw error;
      }
      return async () => {
        const currentOwner = await readRecoveryLeaseOwner(leasePath);
        if (currentOwner?.token !== token) {
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
      };
    } catch (error) {
      if (!isNodeErrorWithCode(error, "EEXIST")) {
        throw error;
      }
    }

    const currentOwner = await readRecoveryLeaseOwner(leasePath);
    if (currentOwner !== undefined && isProcessAlive(currentOwner.pid)) {
      return undefined;
    }
    if (currentOwner === undefined && !(await isPathStale(leasePath))) {
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
  ownerPath: string,
  recoveryOwner: OutputPublicationOwner,
): Promise<void> {
  try {
    const staleOwner = await readPublicationOwner(ownerPath);
    if (staleOwner === undefined) {
      return;
    }
    assertMatchingPublicationTarget(staleOwner, recoveryOwner);
    if (staleOwner.phase === "committed") {
      await removePublicationBackups(staleOwner);
    } else {
      await rollbackOutputPublication(staleOwner);
    }
  } finally {
    await rm(ownerPath, { force: true, recursive: true });
  }
}

function assertMatchingPublicationTarget(
  staleOwner: OutputPublicationOwner,
  recoveryOwner: OutputPublicationOwner,
): void {
  if (
    staleOwner.finalOutputDir !== recoveryOwner.finalOutputDir ||
    staleOwner.finalSummaryPath !== recoveryOwner.finalSummaryPath ||
    staleOwner.outputBackupPath !== `${staleOwner.finalOutputDir}.eve-backup-${staleOwner.token}` ||
    staleOwner.summaryBackupPath !== `${staleOwner.finalSummaryPath}.eve-backup-${staleOwner.token}`
  ) {
    throw new Error("Refusing to recover a build publication for a different output target.");
  }
}

async function rollbackOutputPublication(owner: OutputPublicationOwner): Promise<void> {
  const results = await Promise.allSettled([
    rollbackOneArtifact({
      backupPath: owner.outputBackupPath,
      finalPath: owner.finalOutputDir,
      hadPrevious: owner.hadOutput,
      stagedPath: owner.stagedOutputDir,
    }),
    rollbackOneArtifact({
      backupPath: owner.summaryBackupPath,
      finalPath: owner.finalSummaryPath,
      hadPrevious: owner.hadSummary,
      stagedPath: owner.stagedSummaryPath,
    }),
  ]);
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "Failed to restore the previous build publication.");
  }
}

async function rollbackOneArtifact(input: {
  readonly backupPath: string;
  readonly finalPath: string;
  readonly hadPrevious: boolean;
  readonly stagedPath: string;
}): Promise<void> {
  if (await pathExists(input.backupPath)) {
    if (!(await pathExists(input.stagedPath)) && (await pathExists(input.finalPath))) {
      await mkdir(dirname(input.stagedPath), { recursive: true });
      await rename(input.finalPath, input.stagedPath);
    } else {
      await rm(input.finalPath, { force: true, recursive: true });
    }
    await rename(input.backupPath, input.finalPath);
    return;
  }

  if (
    !input.hadPrevious &&
    !(await pathExists(input.stagedPath)) &&
    (await pathExists(input.finalPath))
  ) {
    await mkdir(dirname(input.stagedPath), { recursive: true });
    await rename(input.finalPath, input.stagedPath);
  }
}

async function removePublicationBackups(owner: OutputPublicationOwner): Promise<void> {
  await Promise.all([
    rm(owner.outputBackupPath, { force: true, recursive: true }),
    rm(owner.summaryBackupPath, { force: true, recursive: true }),
  ]);
}

async function writePublicationOwner(
  lockPath: string,
  owner: OutputPublicationOwner,
): Promise<void> {
  const ownerPath = join(lockPath, "owner.json");
  const temporaryPath = `${ownerPath}.${owner.token}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(owner, null, 2)}\n`);
  await rename(temporaryPath, ownerPath);
}

async function readPublicationOwner(lockPath: string): Promise<OutputPublicationOwner | undefined> {
  try {
    const value = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as unknown;
    return isOutputPublicationOwner(value) ? value : undefined;
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT") || error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

async function writeRecoveryLeaseOwner(
  leasePath: string,
  owner: RecoveryLeaseOwner,
): Promise<void> {
  const ownerPath = join(leasePath, "owner.json");
  const temporaryPath = `${ownerPath}.${owner.token}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(owner, null, 2)}\n`);
  await rename(temporaryPath, ownerPath);
}

async function readRecoveryLeaseOwner(leasePath: string): Promise<RecoveryLeaseOwner | undefined> {
  try {
    const value = JSON.parse(await readFile(join(leasePath, "owner.json"), "utf8")) as unknown;
    return isRecoveryLeaseOwner(value) ? value : undefined;
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT") || error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

function isOutputPublicationOwner(value: unknown): value is OutputPublicationOwner {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const owner = value as Partial<OutputPublicationOwner>;
  return (
    typeof owner.finalOutputDir === "string" &&
    typeof owner.finalSummaryPath === "string" &&
    typeof owner.hadOutput === "boolean" &&
    typeof owner.hadSummary === "boolean" &&
    typeof owner.outputBackupPath === "string" &&
    ["acquired", "prepared", "backed-up", "installed", "committed"].includes(owner.phase ?? "") &&
    typeof owner.pid === "number" &&
    typeof owner.stagedOutputDir === "string" &&
    typeof owner.stagedSummaryPath === "string" &&
    typeof owner.startedAt === "string" &&
    typeof owner.summaryBackupPath === "string" &&
    typeof owner.token === "string"
  );
}

function isRecoveryLeaseOwner(value: unknown): value is RecoveryLeaseOwner {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const owner = value as Partial<RecoveryLeaseOwner>;
  return (
    typeof owner.pid === "number" &&
    typeof owner.startedAt === "string" &&
    typeof owner.token === "string"
  );
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
  const [lockOwner, recoveryOwner, lockExists, recoveryExists] = await Promise.all([
    readPublicationOwner(lockPath),
    readRecoveryLeaseOwner(join(recoveryPath, "lease")),
    pathExists(lockPath),
    pathExists(recoveryPath),
  ]);
  return JSON.stringify({
    lockExists,
    lockToken: lockOwner?.token,
    recoveryExists,
    recoveryToken: recoveryOwner?.token,
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
  if (pid <= 0) {
    return false;
  }
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
