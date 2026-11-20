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

export interface DevDiagnosticLogEntry {
  readonly id: string;
  readonly path: string;
  readonly startedAt: Date | undefined;
  readonly sizeBytes: number;
}

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
      `No diagnostic log matches "${reference}". Run \`eve logs list\` to see available logs.`,
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

export interface LogsShowCommandOptions {
  dump?: boolean;
  events?: boolean;
  readEvents?: (appRoot: string, window: DevSessionEventWindow) => Promise<DevSessionEventLine[]>;
  now?: () => Date;
}

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
    logger.log(content.trimEnd());
    return;
  }
  logger.log(`${dumpContent.trimEnd()}\n${content.trimEnd()}`);
}

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

function mergeLogWithEvents(content: string, events: readonly DevSessionEventLine[]): string {
  const logLines: { at: string; line: string }[] = [];
  let lastAt = "";
  for (const line of content.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const at = (JSON.parse(line) as { at?: unknown }).at;
      if (typeof at === "string") lastAt = at;
    } catch {}
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

export interface LogsListCommandOptions {
  json?: boolean;
}

export interface DevDiagnosticLogJson {
  id: string;
  path: string;
  startedAt: string | null;
  sizeBytes: number;
}

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
