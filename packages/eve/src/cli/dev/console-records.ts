import { format } from "node:util";
import { setLogRecordSubscriber, type LogLevel } from "#internal/logging.js";

export const CONSOLE_RECORD_PREFIX = "\u001eeve-console:";

export interface ConsoleRecord {
  readonly level: LogLevel;
  readonly text: string;
}

let subscriber: ((record: ConsoleRecord) => void) | undefined;

export function setConsoleRecordSubscriber(value: typeof subscriber): void {
  subscriber = value;
}

export function forwardConsoleRecord(record: ConsoleRecord): void {
  if (subscriber !== undefined) {
    try {
      subscriber(record);
      return;
    } catch {}
  }
  console[record.level === "info" ? "log" : record.level](record.text);
}

export function createConsoleOutputForwarder(raw: (text: string) => void): {
  write(chunk: string): void;
  flush(): void;
} {
  let buffered = "";
  return {
    write(chunk) {
      buffered += chunk;
      if (buffered.length > 1024 * 1024 && !buffered.includes("\n")) {
        raw(buffered);
        buffered = "";
      }
      let newline: number;
      while ((newline = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const record = parseConsoleRecord(line);
        if (record === undefined) raw(`${line}\n`);
        else forwardConsoleRecord(record);
      }
    },
    flush() {
      if (buffered.length > 0) raw(buffered);
      buffered = "";
    },
  };
}

export function parseConsoleRecord(line: string): ConsoleRecord | undefined {
  if (!line.startsWith(CONSOLE_RECORD_PREFIX)) return undefined;
  try {
    const record = JSON.parse(line.slice(CONSOLE_RECORD_PREFIX.length));
    if (
      ["error", "warn", "info", "debug"].includes(record.level) &&
      typeof record.text === "string"
    )
      return record;
  } catch {}
  return undefined;
}

/** Runs in the dev child and its worker threads before application imports. */
export function installConsoleRecords(): void {
  const write = (record: ConsoleRecord) =>
    process.stderr.write(`${CONSOLE_RECORD_PREFIX}${JSON.stringify(record)}\n`);
  setLogRecordSubscriber((record) =>
    write({
      level: record.level,
      text: `[eve:${record.namespace}] ${record.message}${record.fields === undefined ? "" : ` ${JSON.stringify(record.fields)}`}`,
    }),
  );
  for (const [method, level] of Object.entries({
    error: "error",
    warn: "warn",
    log: "info",
    info: "info",
    debug: "debug",
  }) as Array<["error" | "warn" | "log" | "info" | "debug", LogLevel]>) {
    console[method] = (...args: unknown[]) => {
      write({ level, text: format(...args) });
    };
  }
}
