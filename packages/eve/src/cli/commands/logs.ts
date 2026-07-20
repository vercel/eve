import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import {
  readDevSessionEvents,
  type DevSessionEventLine,
  type DevSessionEventWindow,
} from "./logs-events.js";

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
  /** Interleave session events resolved from the local workflow store. */
  events?: boolean;
  /** Injectable event reader and clock; defaults to the real store and `Date.now`. */
  readEvents?: (appRoot: string, window: DevSessionEventWindow) => Promise<DevSessionEventLine[]>;
  now?: () => Date;
}

/**
 * `eve logs [logid]`: prints one diagnostic log to stdout — the most recent
 * when `logid` is omitted. The output carries nothing but records (no
 * resolved-path banner, no progress notes on either stream), so
 * `eve logs 2>&1 | jq` always parses; discover ids and paths with
 * `eve logs ls`. With `--dump`, the log's environment dump (a JSON
 * document) is prepended to the JSONL log body, forming one
 * self-contained, parseable report. With `--events`, session events are
 * resolved from the local workflow store at query time — never duplicated
 * into the log at capture time — and interleaved by timestamp as
 * `source: "event"` records.
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
  let content = await readFile(entry.path, "utf8");

  if (options.events === true) {
    const window = eventWindowForLog(logs, entry, options.now ?? (() => new Date()));
    const events = await (options.readEvents ?? readDevSessionEvents)(appRoot, window);
    if (events.length > 0) {
      content = mergeLogWithEvents(content, events);
    }
  }

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
  // A JSON document followed by JSON Lines is one valid JSON value stream,
  // so the combined output stays parseable end to end (`... | jq -c .`).
  logger.log(`${dumpContent.trimEnd()}\n${content.trimEnd()}`);
}

/**
 * The wall-clock window one diagnostic log covers: its encoded start time
 * through the next log's start (logs are per-process and MRU-sorted), or
 * `now` for the most recent log. The store does not attribute runs to
 * processes, so window selection is by time; concurrent `eve dev`
 * processes will see each other's events.
 */
function eventWindowForLog(
  logs: readonly DevDiagnosticLogEntry[],
  entry: DevDiagnosticLogEntry,
  now: () => Date,
): DevSessionEventWindow {
  const index = logs.findIndex((log) => log.id === entry.id);
  const nextStart = index > 0 ? logs[index - 1]!.startedAt : undefined;
  return {
    from: entry.startedAt ?? new Date(0),
    to: nextStart ?? now(),
  };
}

/**
 * Interleaves event lines into the JSONL log by each record's `at`. Log
 * lines keep their relative order; an unparseable line inherits its
 * predecessor's timestamp so it cannot drift.
 */
function mergeLogWithEvents(content: string, events: readonly DevSessionEventLine[]): string {
  const logLines: { at: string; line: string }[] = [];
  let lastAt = "";
  for (const line of content.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const at = (JSON.parse(line) as { at?: unknown }).at;
      if (typeof at === "string") lastAt = at;
    } catch {
      // Keep position relative to the previous record.
    }
    logLines.push({ at: lastAt, line });
  }

  const eventLines = events.map((event) => ({ at: event.at, line: JSON.stringify(event) }));
  const merged: string[] = [];
  let logIndex = 0;
  let eventIndex = 0;
  while (logIndex < logLines.length || eventIndex < eventLines.length) {
    const nextLog = logLines[logIndex];
    const nextEvent = eventLines[eventIndex];
    if (nextEvent === undefined || (nextLog !== undefined && nextLog.at <= nextEvent.at)) {
      merged.push(nextLog!.line);
      logIndex += 1;
    } else {
      merged.push(nextEvent.line);
      eventIndex += 1;
    }
  }
  return `${merged.join("\n")}\n`;
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
