import { setLogRecordSubscriber, type LogRecord } from "#internal/logging.js";

import {
  createDevDiagnosticDump,
  type CreateDevDiagnosticDumpOptions,
  type DevDiagnosticDump,
  type DevSessionStats,
} from "./diagnostic-dump.js";
import {
  createDevDiagnosticSink,
  type DevDiagnosticEntry,
  type DevDiagnosticSink,
} from "./diagnostic-sink.js";

/**
 * The one diagnostics recorder an `eve dev` process owns: the per-process
 * JSONL log (sink), its environment dump, session-stats accumulation, and
 * ownership of eve's structured log records. The TUI holds a single
 * reference and calls in at its capture points; everything stateful about
 * diagnostics lives here, not in the renderer.
 */
export interface DevDiagnostics {
  /** Project-relative path of the diagnostic log, for transcript pointers. */
  readonly displayPath: string;
  /** Appends one captured record to the per-process diagnostic log. */
  append(entry: DevDiagnosticEntry): void;
  recordPrompt(): void;
  recordStepUsage(usage: { inputTokens?: number; outputTokens?: number } | undefined): void;
  recordToolCall(toolName: string): void;
  recordSubagentDispatch(callId: string): void;
  /** Rewrites the environment dump with the stats accumulated so far. */
  reportStats(): void;
  /**
   * Takes ownership of eve's structured log records: each record is
   * persisted to the log with its structure intact and then handed to
   * `onRecord` for display. While subscribed, records never reach the
   * console, so a host that also scrapes stderr sees each record exactly
   * once.
   */
  subscribeLogRecords(onRecord: (record: LogRecord) => void): void;
  unsubscribeLogRecords(): void;
  close(): Promise<void>;
}

/**
 * Creates the diagnostics recorder for one `eve dev` process: the
 * exclusive per-process log plus its same-instance environment dump.
 * Rejects when the log cannot be created (callers run without
 * diagnostics rather than crash the TUI).
 */
export async function createDevDiagnostics(
  appRoot: string,
  options: CreateDevDiagnosticDumpOptions = {},
): Promise<DevDiagnostics> {
  const sink = await createDevDiagnosticSink(appRoot);
  const dump = createDevDiagnosticDump(appRoot, sink.path, options);
  return new DevDiagnosticsRecorder(sink, dump);
}

class DevDiagnosticsRecorder implements DevDiagnostics {
  readonly displayPath: string;
  readonly #sink: DevDiagnosticSink;
  readonly #dump: DevDiagnosticDump;

  #prompts = 0;
  #inputTokens = 0;
  #outputTokens = 0;
  readonly #toolCalls = new Map<string, number>();
  readonly #subagentCallIds = new Set<string>();

  constructor(sink: DevDiagnosticSink, dump: DevDiagnosticDump) {
    this.displayPath = sink.displayPath;
    this.#sink = sink;
    this.#dump = dump;
  }

  append(entry: DevDiagnosticEntry): void {
    this.#sink.append(entry);
  }

  recordPrompt(): void {
    this.#prompts += 1;
  }

  recordStepUsage(usage: { inputTokens?: number; outputTokens?: number } | undefined): void {
    this.#inputTokens += usage?.inputTokens ?? 0;
    this.#outputTokens += usage?.outputTokens ?? 0;
  }

  recordToolCall(toolName: string): void {
    this.#toolCalls.set(toolName, (this.#toolCalls.get(toolName) ?? 0) + 1);
  }

  recordSubagentDispatch(callId: string): void {
    this.#subagentCallIds.add(callId);
  }

  reportStats(): void {
    const stats: DevSessionStats = {
      prompts: this.#prompts,
      inputTokens: this.#inputTokens,
      outputTokens: this.#outputTokens,
      toolCalls: Object.fromEntries(this.#toolCalls),
      subagents: this.#subagentCallIds.size,
    };
    this.#dump.updateSessionStats(stats);
  }

  subscribeLogRecords(onRecord: (record: LogRecord) => void): void {
    setLogRecordSubscriber((record) => {
      const base = {
        source: "log" as const,
        level: record.level,
        namespace: record.namespace,
        message: record.message,
      };
      this.#sink.append(record.fields === undefined ? base : { ...base, fields: record.fields });
      onRecord(record);
    });
  }

  unsubscribeLogRecords(): void {
    setLogRecordSubscriber(undefined);
  }

  async close(): Promise<void> {
    await this.#dump.close();
    await this.#sink.close();
  }
}
