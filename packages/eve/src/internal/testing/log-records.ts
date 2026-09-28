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

/** Logged when a background task reports back after its parent session ended. */
export const taskParentEndedNotice =
  "[eve:execution.tasks.run] task notification target is gone; the parent session already ended";

// The workflow SDK reports a duplicate in-process delivery of the same step
// whenever redelivery races a slow step, so its presence depends on load.
const WORKFLOW_STEP_SINGLE_FLIGHT_NOTICE =
  "[workflow-sdk] Step execution already in flight in this process";

/**
 * Captures `console.error` and `console.warn` for the rest of the current
 * test and records the first argument of each call.
 *
 * Use this only for output that {@link captureLogRecords} cannot reach: code
 * running inside the bundled workflow runtime has its own copy of the eve
 * logger, and the vendored workflow SDK writes to the console directly.
 * `unexpected()` returns the lines that start with none of the given
 * prefixes, ignoring the SDK's load-dependent single-flight notice.
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
          !line.startsWith(WORKFLOW_STEP_SINGLE_FLIGHT_NOTICE) &&
          !expected.some((prefix) => line.startsWith(prefix)),
      ),
  };
}
