import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { atomicWriteFile } from "#shared/atomic-write-file.js";
import { isErrnoCode } from "#shared/guards.js";

export type OutputPublicationPhase = "acquired" | "prepared" | "backed-up" | "committed";

export interface OutputPublicationJournal {
  readonly finalOutputDir: string;
  readonly finalSummaryPath: string;
  hadOutput: boolean;
  hadSummary: boolean;
  liveness: "active" | "recoverable";
  readonly outputBackupPath: string;
  phase: OutputPublicationPhase;
  readonly pid: number;
  readonly scratchDir: string;
  readonly stagedOutputDir: string;
  readonly stagedSummaryPath: string;
  readonly summaryBackupPath: string;
  readonly token: string;
}

export interface RecoveryLeaseJournal {
  readonly pid: number;
  readonly token: string;
}

export async function writeOutputPublicationJournal(
  lockPath: string,
  journal: OutputPublicationJournal,
): Promise<void> {
  await writeJournal(lockPath, journal);
}

export async function readOutputPublicationJournal(
  lockPath: string,
): Promise<OutputPublicationJournal | undefined> {
  const value = await readJournal(lockPath);
  return isOutputPublicationJournal(value) ? value : undefined;
}

export async function writeRecoveryLeaseJournal(
  leasePath: string,
  journal: RecoveryLeaseJournal,
): Promise<void> {
  await writeJournal(leasePath, journal);
}

export async function readRecoveryLeaseJournal(
  leasePath: string,
): Promise<RecoveryLeaseJournal | undefined> {
  const value = await readJournal(leasePath);
  return isRecoveryLeaseJournal(value) ? value : undefined;
}

/**
 * Resolves the journal file inside a lock or lease directory. Exposed so
 * the lock module can heartbeat the file's mtime while a publication or
 * recovery is in flight.
 */
export function resolveJournalFilePath(path: string): string {
  return join(path, "owner.json");
}

async function writeJournal(path: string, journal: unknown): Promise<void> {
  await atomicWriteFile(resolveJournalFilePath(path), `${JSON.stringify(journal, null, 2)}\n`);
}

async function readJournal(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(resolveJournalFilePath(path), "utf8")) as unknown;
  } catch (error) {
    if (isErrnoCode(error, "ENOENT") || error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

function isOutputPublicationJournal(value: unknown): value is OutputPublicationJournal {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const journal = value as Partial<OutputPublicationJournal>;
  return (
    typeof journal.finalOutputDir === "string" &&
    typeof journal.finalSummaryPath === "string" &&
    typeof journal.hadOutput === "boolean" &&
    typeof journal.hadSummary === "boolean" &&
    (journal.liveness === "active" || journal.liveness === "recoverable") &&
    typeof journal.outputBackupPath === "string" &&
    ["acquired", "prepared", "backed-up", "committed"].includes(journal.phase ?? "") &&
    typeof journal.pid === "number" &&
    typeof journal.scratchDir === "string" &&
    typeof journal.stagedOutputDir === "string" &&
    typeof journal.stagedSummaryPath === "string" &&
    typeof journal.summaryBackupPath === "string" &&
    typeof journal.token === "string"
  );
}

function isRecoveryLeaseJournal(value: unknown): value is RecoveryLeaseJournal {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const journal = value as Partial<RecoveryLeaseJournal>;
  return typeof journal.pid === "number" && typeof journal.token === "string";
}
