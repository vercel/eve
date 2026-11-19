import { chmod, mkdir, open, type FileHandle } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import type { LogLevel } from "#internal/logging.js";
import type { JsonObject } from "#shared/json.js";

type DevDiagnosticSource = "stderr" | "stdout" | "sandbox" | "workflow" | "tool" | "log";

export interface DevDiagnosticOutputEntry {
  readonly source: Exclude<DevDiagnosticSource, "log">;
  readonly level?: LogLevel;
  readonly summary?: string;
  readonly detail: string;
  readonly hint?: string;
}

export interface DevDiagnosticLogRecordEntry {
  readonly source: "log";
  readonly level: LogLevel;
  readonly namespace: string;
  readonly message: string;
  readonly fields?: JsonObject;
}

export type DevDiagnosticEntry = DevDiagnosticOutputEntry | DevDiagnosticLogRecordEntry;

export interface DevDiagnosticSink {
  readonly path: string;
  readonly displayPath: string;
  append(entry: DevDiagnosticEntry): void;
  close(): Promise<void>;
}

interface CreateDevDiagnosticSinkOptions {
  readonly now?: () => Date;
  readonly pid?: number;
}

export async function createDevDiagnosticSink(
  appRoot: string,
  options: CreateDevDiagnosticSinkOptions = {},
): Promise<DevDiagnosticSink> {
  const directory = join(appRoot, ".eve", "logs");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);

  const now = options.now?.() ?? new Date();
  const pid = options.pid ?? process.pid;
  const timestamp = now.toISOString().replaceAll(":", "-");
  const path = join(directory, `dev-${timestamp}-${pid}.log`);
  const handle = await open(path, "wx", 0o600);
  return createOpenSink(appRoot, path, handle, () => options.now?.() ?? new Date());
}

function createOpenSink(
  appRoot: string,
  path: string,
  handle: FileHandle,
  now: () => Date,
): DevDiagnosticSink {
  let queue = Promise.resolve();
  let failed = false;
  let closed = false;

  return {
    path,
    displayPath: relative(appRoot, path).split(sep).join("/"),
    append(entry) {
      if (closed || failed) return;
      const record = formatDiagnosticEntry(entry, now());
      queue = queue
        .then(() => handle.appendFile(record, "utf8"))
        .catch(() => {
          failed = true;
        });
    },
    async close() {
      if (closed) return;
      closed = true;
      await queue;
      await handle.close();
    },
  };
}

function formatDiagnosticEntry(entry: DevDiagnosticEntry, at: Date): string {
  return `${JSON.stringify({ at: at.toISOString(), ...entry })}\n`;
}
