import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

import type { OutputPublicationJournal } from "#internal/application/output-publication-journal.js";
import { pathExists } from "#shared/path-exists.js";

export async function assertStagedPublicationExists(
  journal: OutputPublicationJournal,
): Promise<void> {
  await Promise.all([stat(journal.stagedOutputDir), stat(journal.stagedSummaryPath)]);
}

export async function prepareOutputPublication(journal: OutputPublicationJournal): Promise<void> {
  [journal.hadOutput, journal.hadSummary] = await Promise.all([
    pathExists(journal.finalOutputDir),
    pathExists(journal.finalSummaryPath),
  ]);
  await Promise.all([
    mkdir(dirname(journal.finalOutputDir), { recursive: true }),
    mkdir(dirname(journal.finalSummaryPath), { recursive: true }),
  ]);
}

export async function backupOutputPublication(journal: OutputPublicationJournal): Promise<void> {
  if (journal.hadOutput) {
    await rename(journal.finalOutputDir, journal.outputBackupPath);
  }
  if (journal.hadSummary) {
    await rename(journal.finalSummaryPath, journal.summaryBackupPath);
  }
}

export async function installOutputPublication(
  journal: OutputPublicationJournal,
  afterOutputInstall: () => Promise<void>,
): Promise<void> {
  await rename(journal.stagedOutputDir, journal.finalOutputDir);
  await afterOutputInstall();
  await rename(journal.stagedSummaryPath, journal.finalSummaryPath);
}

export async function rollbackOutputPublication(journal: OutputPublicationJournal): Promise<void> {
  const results = await Promise.allSettled([
    rollbackArtifact({
      backupPath: journal.outputBackupPath,
      finalPath: journal.finalOutputDir,
      hadPrevious: journal.hadOutput,
      stagedPath: journal.stagedOutputDir,
    }),
    rollbackArtifact({
      backupPath: journal.summaryBackupPath,
      finalPath: journal.finalSummaryPath,
      hadPrevious: journal.hadSummary,
      stagedPath: journal.stagedSummaryPath,
    }),
  ]);
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "Failed to restore the previous build publication.");
  }
}

export async function removeOutputPublicationBackups(
  journal: OutputPublicationJournal,
): Promise<void> {
  await Promise.all([
    rm(journal.outputBackupPath, { force: true, recursive: true }),
    rm(journal.summaryBackupPath, { force: true, recursive: true }),
  ]);
}

async function rollbackArtifact(input: {
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
