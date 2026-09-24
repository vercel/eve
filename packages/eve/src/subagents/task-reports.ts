import { MAX_OUTPUT_BYTES } from "#execution/sandbox/truncate-output.js";
import { getRun } from "#internal/workflow/runtime.js";
import type { JsonValue } from "#shared/json.js";
import { truncateTaskResult } from "#tasks/render.js";

// A delegated session keeps the latest result it reported to a remote caller
// for each call, in a stream of its own run apart from its public event
// stream, one stream per call. The caller's deadline reads it when a callback
// never arrived. Each report is kept for the callback it was sent to, and only
// the holder of that callback's token can read it back.

const TASK_REPORTS_NAMESPACE_PREFIX = "eve.task-reports.";

/** A recorded report: what the callback carried, and a hash of the callback token it was sent to. */
interface StoredTaskReport {
  readonly report: Record<string, unknown>;
  readonly tokenHash: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Records the callback body a session is about to send its caller for one
 * call. A retried callback step records the same answer once. Output past
 * the result truncation limit is kept as the truncated text the caller's
 * model would read.
 */
export async function recordTaskReport(input: {
  readonly callbackToken: string;
  readonly report: { readonly callId: string; readonly answer?: number } & Record<string, unknown>;
  readonly sessionId: string;
}): Promise<void> {
  // Only answers settle a call; a cancelled call's report settles nothing.
  if (input.report.answer === undefined) return;
  const namespace = await reportNamespace(input.report.callId);
  const latest = await readTailReport(input.sessionId, namespace);
  if (latest?.report.answer === input.report.answer) return;

  const stored: StoredTaskReport = {
    report: capReport(input.report),
    tokenHash: await sha256(input.callbackToken),
  };
  const ops: Promise<unknown>[] = [];
  const writer = getRun(input.sessionId).getWritable<Uint8Array>({ namespace, ops }).getWriter();
  try {
    await writer.write(encoder.encode(`${JSON.stringify(stored)}\n`));
  } finally {
    writer.releaseLock();
  }
  await Promise.all(ops);
}

/**
 * The latest report a session recorded for one call, when it was sent to the
 * callback whose token the reader presents. `undefined` otherwise, so a
 * reader cannot tell a report kept for another callback from no report.
 */
export async function readLatestTaskReport(input: {
  readonly callbackToken: string;
  readonly callId: string;
  readonly sessionId: string;
}): Promise<Record<string, unknown> | undefined> {
  const latest = await readTailReport(input.sessionId, await reportNamespace(input.callId));
  if (latest === undefined || latest.tokenHash !== (await sha256(input.callbackToken))) {
    return undefined;
  }
  return latest.report;
}

async function readTailReport(
  sessionId: string,
  namespace: string,
): Promise<StoredTaskReport | undefined> {
  const run = getRun(sessionId);
  const probe = run.getReadable<Uint8Array>({ namespace });
  let tail: number;
  try {
    tail = await probe.getTailIndex();
  } finally {
    await probe.cancel().catch(() => {});
  }
  if (tail < 0) return undefined;

  // Read exactly the tail chunk: the stream stays open while the session lives.
  const reader = run.getReadable<Uint8Array>({ namespace, startIndex: tail }).getReader();
  try {
    const { done, value } = await reader.read();
    if (done) return undefined;
    const lines = decoder.decode(value).split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const stored = parseStoredReport(lines[index]!);
      if (stored !== undefined) return stored;
    }
    return undefined;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function capReport(report: Record<string, unknown>): Record<string, unknown> {
  const output = report.output as JsonValue | undefined;
  if (output === undefined) return report;
  const text = typeof output === "string" ? output : JSON.stringify(output, null, 2);
  if (encoder.encode(text).byteLength <= MAX_OUTPUT_BYTES) return report;
  return { ...report, output: truncateTaskResult(text) };
}

async function reportNamespace(callId: string): Promise<string> {
  // Call IDs come from model providers; a hash keeps the namespace well-formed.
  return `${TASK_REPORTS_NAMESPACE_PREFIX}${(await sha256(callId)).slice(0, 32)}`;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseStoredReport(line: string): StoredTaskReport | undefined {
  if (line.trim().length === 0) return undefined;
  try {
    const value: unknown = JSON.parse(line);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const { report, tokenHash } = value as Record<string, unknown>;
    if (typeof tokenHash !== "string") return undefined;
    if (report === null || typeof report !== "object" || Array.isArray(report)) return undefined;
    return { report: report as Record<string, unknown>, tokenHash };
  } catch {
    return undefined;
  }
}
