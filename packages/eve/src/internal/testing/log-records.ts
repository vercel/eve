import { onTestFinished, vi } from "vitest";

import { setLogRecordSubscriber, type LogRecord } from "#internal/logging.js";

/**
 * Routes eve logger records to an array for the rest of the current test
 * instead of the console, so a test that drives an expected failure path
 * can assert the record it produces rather than printing it.
 *
 * The subscriber slot is process-wide, so the helper registers its own
 * teardown rather than leaving that to each caller.
 */
export function captureLogRecords(): { readonly records: LogRecord[] } {
  const records: LogRecord[] = [];
  setLogRecordSubscriber((record) => records.push(record));
  onTestFinished(() => setLogRecordSubscriber(undefined));
  return { records };
}

/** Prefixes of workflow SDK console notices that integration tests drive on purpose. */
export const workflowSdkNotice = {
  fatalStep: "[workflow-sdk] Encountered FatalError while executing step",
  ignoredLatestDeployment: "[workflow-sdk] deploymentId: 'latest' has no effect in this world",
  maxRetries: "[workflow-sdk] Max retries reached, bubbling error to parent workflow",
  unpinnedDelivery:
    "[workflow-sdk] Queue message was delivered to a deployment it was not pinned to",
} as const;

// Notices of self-healing races whose presence depends on load: the workflow
// SDK reports a duplicate in-process delivery when redelivery races a slow
// step, rethrows a transient conflict so the local queue retries the message,
// and restores a run_created event whose write is still in flight.
const LOAD_DEPENDENT_NOTICES = [
  "[workflow-sdk] Step execution already in flight in this process",
  "[world-local] Queue message failed (attempt ",
  "[world-local] restored missing run_created for ",
] as const;

/**
 * Captures `console.error` and `console.warn` for the rest of the current
 * test and records the first argument of each call.
 *
 * Use this only for output that {@link captureLogRecords} cannot reach: code
 * running inside the bundled workflow runtime has its own copy of the eve
 * logger, and the vendored workflow SDK writes to the console directly.
 * `unexpected()` returns the lines that start with none of the given
 * prefixes, ignoring the workflow runtime's load-dependent recovery notices.
 */
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
