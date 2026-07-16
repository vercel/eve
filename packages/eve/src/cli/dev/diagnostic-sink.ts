import { chmod, mkdir, open, type FileHandle } from "node:fs/promises";
import { join, relative } from "node:path";

export type DevDiagnosticSource = "stderr" | "workflow" | "transport";

export interface DevDiagnosticEntry {
  readonly source: DevDiagnosticSource;
  readonly summary?: string;
  readonly detail: string;
}

export interface DevDiagnosticSink {
  readonly path: string;
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
    displayPath: relative(appRoot, path),
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

function formatDiagnosticEntry(entry: DevDiagnosticEntry, at: Date): string {
  const summary = entry.summary === undefined ? "" : `${entry.summary.trim()}\n`;
  return `[${at.toISOString()}] ${entry.source}\n${summary}${entry.detail.trimEnd()}\n\n`;
}
