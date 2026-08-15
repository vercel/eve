import { chmod, mkdir, open, type FileHandle } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import type { LogLevel } from "#internal/logging.js";
import type { JsonObject } from "#shared/json.js";

export type DevDiagnosticSource = "stderr" | "stdout" | "sandbox" | "workflow" | "tool" | "log";

/** Captured output or a failure summary attributed to one capture point. */
export interface DevDiagnosticOutputEntry {
  readonly source: Exclude<DevDiagnosticSource, "log">;
  readonly summary?: string;
  readonly detail: string;
  /** Structured remediation carried by cataloged failures. */
  readonly hint?: string;
}

/** One structured record from eve's own logger. */
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
  /**
   * Project-relative reference with forward slashes on every platform:
   * it is a display and correlation token (transcript pointers,
   * `eve logs <ref>` input), not a filesystem path.
   */
  readonly displayPath: string;
  append(entry: DevDiagnosticEntry): void;
  close(): Promise<void>;
}

export interface CreateDevDiagnosticSinkOptions {
  readonly now?: () => Date;
  readonly pid?: number;
}

/** Creates the local, process-owned diagnostics file used by `eve dev`. */
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
          // Never report through stderr: the TUI captures it and would recurse.
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

/**
 * JSON Lines: each record is one JSON object per line, `at` and `source`
 * first. Multi-line details (stack traces, inspector dumps) are escaped by
 * the JSON encoding, so the line-per-record invariant holds and the whole
 * file parses with any JSONL reader (`jq -c 'select(.source=="tool")'`).
 */
function formatDiagnosticEntry(entry: DevDiagnosticEntry, at: Date): string {
  return `${JSON.stringify({ at: at.toISOString(), ...entry })}\n`;
}
