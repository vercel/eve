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
} from "#internal/application/output-publication-lock.js";

export { resolveOutputPublicationLockPath };

export interface OutputPublicationInput {
  readonly appRoot: string;
  readonly finalOutputDir: string;
  readonly finalSummaryPath: string;
  readonly stagedOutputDir: string;
  readonly stagedSummaryPath: string;
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
    await removeOutputPublicationBackups(journal);
  } catch (error) {
    if (journal.phase === "committed") {
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
    throw new AggregateError([...input.errors, journalWriteError], input.message, {
      cause: input.errors[0],
    });
  }
  throw new AggregateError(input.errors, input.message, { cause: input.errors[0] });
}
