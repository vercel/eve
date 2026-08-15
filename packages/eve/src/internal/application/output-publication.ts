import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  assertStagedPublicationExists,
  backupOutputPublication,
  installOutputPublication,
  prepareOutputPublication,
  removeOutputPublicationBackups,
  rollbackOutputPublication,
} from "#internal/application/output-publication-artifacts.js";
import type { OutputPublicationJournal } from "#internal/application/output-publication-journal.js";
import { writeOutputPublicationJournal } from "#internal/application/output-publication-journal.js";
import {
  acquireOutputPublicationLock,
  resolveOutputPublicationLockPath,
  startPublicationJournalHeartbeat,
} from "#internal/application/output-publication-lock.js";

export { resolveOutputPublicationLockPath };

export interface OutputPublicationInput {
  readonly appRoot: string;
  readonly finalOutputDir: string;
  readonly finalSummaryPath: string;
  /** Invocation-owned directory containing the staged paths; recovery removes it. */
  readonly scratchDir: string;
  readonly stagedOutputDir: string;
  readonly stagedSummaryPath: string;
}

/**
 * A publication failure that retained the lock journal on disk. The staged
 * artifacts (and the scratch directory containing them) must outlive this
 * invocation so a later build can finish the interrupted publication.
 */
export class RecoverablePublicationError extends AggregateError {
  constructor(errors: readonly unknown[], message: string, options?: ErrorOptions) {
    super(errors, message, options);
    this.name = "RecoverablePublicationError";
  }
}

interface OutputPublicationObserver {
  afterBackup(): Promise<void>;
  afterOutputInstall(): Promise<void>;
  onContention(): Promise<void>;
}

const DEFAULT_OBSERVER: OutputPublicationObserver = {
  async afterBackup() {},
  async afterOutputInstall() {},
  async onContention() {},
};

/**
 * Atomically installs a build's staged output and summary as the app's
 * published artifacts: backs up the previous publication, renames the staged
 * paths into place, and rolls back to the backup on failure. A journaled,
 * cross-process lock serializes publishers and lets the next build finish an
 * interrupted publication.
 */
export async function publishApplicationBuildArtifacts(
  input: OutputPublicationInput,
): Promise<void> {
  await publishApplicationBuildArtifactsWithObserver(input, DEFAULT_OBSERVER);
}

export async function publishApplicationBuildArtifactsWithObserver(
  input: OutputPublicationInput,
  observer: OutputPublicationObserver,
): Promise<void> {
  const journal = createOutputPublicationJournal(input);
  await assertStagedPublicationExists(journal);

  const lockPath = resolveOutputPublicationLockPath(input.appRoot);
  const release = await acquireOutputPublicationLock(lockPath, journal, observer.onContention);
  const stopHeartbeat = startPublicationJournalHeartbeat(lockPath);

  let committedJournalWritten = false;
  try {
    await prepareOutputPublication(journal);
    journal.phase = "prepared";
    await writeOutputPublicationJournal(lockPath, journal);

    await backupOutputPublication(journal);
    journal.phase = "backed-up";
    await writeOutputPublicationJournal(lockPath, journal);
    await observer.afterBackup();

    await installOutputPublication(journal, observer.afterOutputInstall);
    journal.phase = "committed";
    await writeOutputPublicationJournal(lockPath, journal);
    committedJournalWritten = true;
    await removeOutputPublicationBackups(journal);
  } catch (error) {
    // Only a durably recorded commit counts: if the journal write itself
    // failed, the on-disk phase still says "backed-up" and a later recovery
    // would roll the new output back out — so roll back now and report the
    // publication as failed.
    if (committedJournalWritten) {
      await throwRecoverablePublicationError({
        errors: [error],
        journal,
        lockPath,
        message: "Build output was committed but backup cleanup failed.",
      });
    }
    try {
      await rollbackOutputPublication(journal);
    } catch (rollbackError) {
      await throwRecoverablePublicationError({
        errors: [error, rollbackError],
        journal,
        lockPath,
        message: "Build output publication failed and could not fully restore the previous output.",
      });
    }
    await release();
    throw error;
  } finally {
    stopHeartbeat();
  }

  await release();
}

function createOutputPublicationJournal(input: OutputPublicationInput): OutputPublicationJournal {
  const token = randomUUID();
  const finalOutputDir = resolve(input.finalOutputDir);
  const finalSummaryPath = resolve(input.finalSummaryPath);
  return {
    finalOutputDir,
    finalSummaryPath,
    hadOutput: false,
    hadSummary: false,
    liveness: "active",
    outputBackupPath: `${finalOutputDir}.eve-backup-${token}`,
    phase: "acquired",
    pid: process.pid,
    scratchDir: resolve(input.scratchDir),
    stagedOutputDir: resolve(input.stagedOutputDir),
    stagedSummaryPath: resolve(input.stagedSummaryPath),
    summaryBackupPath: `${finalSummaryPath}.eve-backup-${token}`,
    token,
  };
}

async function throwRecoverablePublicationError(input: {
  readonly errors: readonly unknown[];
  readonly journal: OutputPublicationJournal;
  readonly lockPath: string;
  readonly message: string;
}): Promise<never> {
  input.journal.liveness = "recoverable";
  try {
    await writeOutputPublicationJournal(input.lockPath, input.journal);
  } catch (journalWriteError) {
    throw new RecoverablePublicationError([...input.errors, journalWriteError], input.message, {
      cause: input.errors[0],
    });
  }
  throw new RecoverablePublicationError(input.errors, input.message, { cause: input.errors[0] });
}
