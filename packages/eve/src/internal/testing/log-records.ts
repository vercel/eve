import { onTestFinished, vi } from "vitest";

import { setLogRecordSubscriber, type LogRecord } from "#internal/logging.js";

export function captureLogRecords(): { readonly records: LogRecord[] } {
  const records: LogRecord[] = [];
  setLogRecordSubscriber((record) => records.push(record));
  onTestFinished(() => setLogRecordSubscriber(undefined));
  return { records };
}

export const workflowSdkNotice = {
  fatalStep: "[workflow-sdk] Encountered FatalError while executing step",
  ignoredLatestDeployment: "[workflow-sdk] deploymentId: 'latest' has no effect in this world",
  maxRetries: "[workflow-sdk] Max retries reached, bubbling error to parent workflow",
  queueRedelivery: "[world-local] Queue message failed (attempt ",
  unpinnedDelivery:
    "[workflow-sdk] Queue message was delivered to a deployment it was not pinned to",
} as const;

const LOAD_DEPENDENT_NOTICES = [
  "[workflow-sdk] Step execution already in flight in this process",
  "[world-local] restored missing run_created for ",
] as const;

export function captureConsoleOutput(): {
  readonly lines: string[];
  unexpected(...expected: string[]): string[];
} {
  const lines: string[] = [];
  const capture = (first?: unknown) => {
    lines.push(String(first));
  };
  const error = vi.spyOn(console, "error").mockImplementation(capture);
  const warn = vi.spyOn(console, "warn").mockImplementation(capture);
  onTestFinished(() => {
    error.mockRestore();
    warn.mockRestore();
  });
  return {
    lines,
    unexpected: (...expected) =>
      lines.filter(
        (line) =>
          ![...LOAD_DEPENDENT_NOTICES, ...expected].some((prefix) => line.startsWith(prefix)),
      ),
  };
}
