import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
  await writeJournal(lockPath, journal, journal.token);
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
  await writeJournal(leasePath, journal, journal.token);
}

export async function readRecoveryLeaseJournal(
  leasePath: string,
): Promise<RecoveryLeaseJournal | undefined> {
  const value = await readJournal(leasePath);
  return isRecoveryLeaseJournal(value) ? value : undefined;
}

async function writeJournal(path: string, journal: unknown, token: string): Promise<void> {
  const journalPath = join(path, "owner.json");
  const temporaryPath = `${journalPath}.${token}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(journal, null, 2)}\n`);
  await rename(temporaryPath, journalPath);
}

async function readJournal(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(path, "owner.json"), "utf8")) as unknown;
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT") || error instanceof SyntaxError) {
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

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
