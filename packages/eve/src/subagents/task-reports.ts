import { getRun } from "#internal/workflow/runtime.js";

// A delegated session keeps every result it reports to a remote caller in a
// separate stream of its own run, apart from its public event stream. The
// caller's deadline reads the latest one when a callback never arrived.

const TASK_REPORTS_NAMESPACE = "eve.task-reports";

/** Reports read back from the end of the stream; older ones answer calls long settled. */
const MAX_REPORTS_READ = 200;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Records the callback body a session is about to send its caller for one call. */
export async function recordTaskReport(input: {
  readonly report: { readonly callId: string } & Record<string, unknown>;
  readonly sessionId: string;
}): Promise<void> {
  const ops: Promise<unknown>[] = [];
  const writer = getRun(input.sessionId)
    .getWritable<Uint8Array>({ namespace: TASK_REPORTS_NAMESPACE, ops })
    .getWriter();
  try {
    await writer.write(encoder.encode(`${JSON.stringify(input.report)}\n`));
  } finally {
    writer.releaseLock();
  }
  await Promise.all(ops);
}

/** The latest report a session recorded for one call, or `undefined` when it has none. */
export async function readLatestTaskReport(input: {
  readonly callId: string;
  readonly sessionId: string;
}): Promise<Record<string, unknown> | undefined> {
  const run = getRun(input.sessionId);
  const probe = run.getReadable<Uint8Array>({ namespace: TASK_REPORTS_NAMESPACE });
  let tail: number;
  try {
    tail = await probe.getTailIndex();
  } finally {
    await probe.cancel().catch(() => {});
  }
  if (tail < 0) return undefined;

  const startIndex = Math.max(0, tail - MAX_REPORTS_READ + 1);
  const reader = run
    .getReadable<Uint8Array>({ namespace: TASK_REPORTS_NAMESPACE, startIndex })
    .getReader();
  let latest: Record<string, unknown> | undefined;
  try {
    // Read exactly to the tail observed above: the stream stays open while the session lives.
    for (let index = startIndex; index <= tail; index += 1) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of decoder.decode(value).split("\n")) {
        const report = parseReport(line);
        if (report?.callId === input.callId) latest = report;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return latest;
}

function parseReport(line: string): Record<string, unknown> | undefined {
  if (line.trim().length === 0) return undefined;
  try {
    const value: unknown = JSON.parse(line);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
