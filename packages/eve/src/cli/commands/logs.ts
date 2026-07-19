import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";

interface CliLogsLogger {
  error(message: string): void;
  log(message: string): void;
}

const LOG_DIRECTORY_SEGMENTS = [".eve", "logs"] as const;
const LOG_DISPLAY_DIRECTORY = LOG_DIRECTORY_SEGMENTS.join("/");
const LOG_ID_PATTERN = /^dev-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z)-\d+\.log$/;

/** One `eve dev` diagnostic log file under `.eve/logs`. */
export interface DevDiagnosticLogEntry {
  /** Stable reference: the file name without the `.log` extension. */
  readonly id: string;
  readonly path: string;
  /** Process start time encoded in the file name, when parseable. */
  readonly startedAt: Date | undefined;
  readonly sizeBytes: number;
}

/**
 * Lists `eve dev` diagnostic logs for an app root, most recent first. The
 * sortable timestamp prefix in each file name provides the ordering; a missing
 * log directory yields an empty list.
 */
export async function listDevDiagnosticLogs(appRoot: string): Promise<DevDiagnosticLogEntry[]> {
  const directory = join(appRoot, ...LOG_DIRECTORY_SEGMENTS);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const fileNames = names
    .filter((name) => LOG_ID_PATTERN.test(name))
    .sort()
    .reverse();
  return Promise.all(
    fileNames.map(async (fileName) => {
      const path = join(directory, fileName);
      return {
        id: fileName.slice(0, -".log".length),
        path,
        startedAt: parseStartedAt(fileName),
        sizeBytes: (await stat(path)).size,
      };
    }),
  );
}

function parseStartedAt(fileName: string): Date | undefined {
  const match = LOG_ID_PATTERN.exec(fileName);
  if (match === null) return undefined;
  const iso = match[1]!.replace(/T(\d{2})-(\d{2})-(\d{2})/, "T$1:$2:$3");
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * Resolves a user-supplied log reference to one entry. Accepts the full id,
 * the file name, the transcript's `.eve/logs/...` path, or any unambiguous
 * prefix of the id (with or without the `dev-` lead).
 */
export function resolveDevDiagnosticLog(
  logs: readonly DevDiagnosticLogEntry[],
  reference: string,
): DevDiagnosticLogEntry {
  const name = basename(reference.replaceAll("\\", "/"));
  const normalized = name.endsWith(".log") ? name.slice(0, -".log".length) : name;

  const exact = logs.find((log) => log.id === normalized);
  if (exact !== undefined) return exact;

  const matches = logs.filter(
    (log) => log.id.startsWith(normalized) || log.id.startsWith(`dev-${normalized}`),
  );
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    throw new Error(
      `No diagnostic log matches "${reference}". Run \`eve logs ls\` to see available logs.`,
    );
  }
  throw new Error(
    [
      `"${reference}" matches ${matches.length} diagnostic logs:`,
      ...matches.map((log) => `  ${log.id}`),
      "Pass a longer prefix or the full id.",
    ].join("\n"),
  );
}

/** Options accepted by {@link runLogsShowCommand}. */
export interface LogsShowCommandOptions {
  /** Prepend the log's environment dump (the same-instance `.dump` sibling). */
  dump?: boolean;
}

/**
 * `eve logs [logid]`: prints one diagnostic log to stdout — the most recent
 * when `logid` is omitted. The resolved file path goes to stderr so piped
 * stdout stays pure log content. With `--dump`, the log's environment dump
 * (a JSON document) is prepended to the JSONL log body, forming one
 * self-contained, parseable report.
 */
export async function runLogsShowCommand(
  logger: CliLogsLogger,
  appRoot: string,
  logId?: string,
  options: LogsShowCommandOptions = {},
): Promise<void> {
  const logs = await listDevDiagnosticLogs(appRoot);
  if (logs.length === 0) {
    const message = `No dev diagnostic logs found under ${LOG_DISPLAY_DIRECTORY}.`;
    if (logId !== undefined) throw new Error(message);
    logger.log(message);
    return;
  }

  const entry = logId === undefined ? logs[0]! : resolveDevDiagnosticLog(logs, logId);
  logger.error(`${LOG_DISPLAY_DIRECTORY}/${entry.id}.log`);
  const content = await readFile(entry.path, "utf8");

  if (options.dump !== true) {
    logger.log(content.trimEnd());
    return;
  }

  const dumpPath = entry.path.slice(0, -".log".length) + ".dump";
  let dumpContent: string | undefined;
  try {
    dumpContent = await readFile(dumpPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (dumpContent === undefined) {
    // No dump for this log (older instance, or the write failed): print the
    // log alone, silently — same output as without the flag.
    logger.log(content.trimEnd());
    return;
  }
  logger.error(`${LOG_DISPLAY_DIRECTORY}/${entry.id}.dump`);
  // A JSON document followed by JSON Lines is one valid JSON value stream,
  // so the combined output stays parseable end to end (`... | jq -c .`).
  logger.log(`${dumpContent.trimEnd()}\n${content.trimEnd()}`);
}

/** Options accepted by {@link runLogsListCommand}. */
export interface LogsListCommandOptions {
  /** Emit a machine-readable JSON array instead of the human listing. */
  json?: boolean;
}

/** Machine-readable row emitted by `eve logs ls --json`. */
export interface DevDiagnosticLogJson {
  id: string;
  path: string;
  startedAt: string | null;
  sizeBytes: number;
}

/** `eve logs ls`: lists diagnostic logs, most recent first. */
export async function runLogsListCommand(
  logger: CliLogsLogger,
  appRoot: string,
  options: LogsListCommandOptions = {},
): Promise<void> {
  const logs = await listDevDiagnosticLogs(appRoot);

  if (options.json) {
    const rows: DevDiagnosticLogJson[] = logs.map((log) => ({
      id: log.id,
      path: log.path,
      startedAt: log.startedAt?.toISOString() ?? null,
      sizeBytes: log.sizeBytes,
    }));
    logger.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (logs.length === 0) {
    logger.log(`No dev diagnostic logs found under ${LOG_DISPLAY_DIRECTORY}.`);
    return;
  }

  for (const log of logs) {
    const started = log.startedAt?.toISOString() ?? "unknown start";
    logger.log(`${log.id}  ${started}  ${formatSize(log.sizeBytes)}`);
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  return `${(kib / 1024).toFixed(1)} MiB`;
}
