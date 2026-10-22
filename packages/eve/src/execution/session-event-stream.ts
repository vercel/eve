import type { SessionStreamEvent } from "#protocol/session-event.js";
import { parseNdjsonStream } from "#execution/ndjson-stream.js";
import { RunExpiredError } from "#compiled/@workflow/errors/index.js";
import { getRun, getWorld } from "#internal/workflow/runtime.js";
import { createEventReader } from "#protocol/session-lines.js";
import { createV26HistoryReader, type V26HistoryReader } from "#execution/v26-history.js";
import { isV26Line } from "#protocol/v26-lines.js";
import { isStoredLine, type StoredLine } from "#protocol/session-events/envelope.js";

/** Options for {@link streamSessionEvents}. */
export interface SessionEventStreamOptions {
  /**
   * Position of the first line to read. Negative values count back from the
   * durable tail (`-1` is the latest line). Defaults to `0`.
   */
  readonly startIndex?: number;
  /**
   * Whether to keep following lines recorded after the read opens. When
   * `false`, the read ends at the durable tail observed when it opens.
   * Defaults to `true`.
   */
  readonly follow?: boolean;
  /** Stops the read and releases the underlying stream reader. */
  readonly signal?: AbortSignal;
}

/** One stored line and its position. A line this version can't read has `line: undefined`. */
export interface PositionedLine {
  readonly position: number;
  readonly line: StoredLine | undefined;
  /** The line as stored, parsed. */
  readonly record: unknown;
}

/**
 * Reads one session's stored records from `startIndex`, one per line, as parsed JSON. Negative
 * `startIndex` values count back from the tail. Callers count positions: one per record.
 */
export function readSessionRecords(
  sessionId: string,
  startIndex?: number,
): ReadableStream<unknown> {
  return parseNdjsonStream<unknown>(() => getRun(sessionId).getReadable({ startIndex }));
}

/**
 * Reads one session's events, following new lines as they're written. Records of types this
 * version doesn't know, including a pre-v27 session's, are skipped.
 */
export function readSessionEventStream(
  sessionId: string,
  startIndex?: number,
  signal?: AbortSignal,
): ReadableStream<SessionStreamEvent> {
  const cancellation = new AbortController();
  const readSignal =
    signal === undefined ? cancellation.signal : AbortSignal.any([signal, cancellation.signal]);
  const lines = streamSessionLines(sessionId, { startIndex, signal: readSignal });
  const reader = createEventReader();
  return new ReadableStream<SessionStreamEvent>({
    async pull(controller) {
      while (true) {
        const next = await lines.next();
        if (next.done === true) {
          controller.close();
          return;
        }
        const { line, position } = next.value;
        if (line === undefined) continue;
        const events = reader.read(line, position);
        if (events.length === 0) continue;
        for (const event of events) controller.enqueue(event);
        return;
      }
    },
    async cancel() {
      // A prefetched next() may be waiting on the live tail; unblock it before return().
      cancellation.abort();
      await lines.return(undefined);
    },
  });
}

/**
 * Reads one session's recorded events up to the durable tail observed when
 * the read opens, then ends. Negative `startIndex` values count back from
 * that tail.
 */
export function readSessionEventHistory(
  sessionId: string,
  startIndex?: number,
  signal?: AbortSignal,
): ReadableStream<SessionStreamEvent> {
  const events = streamSessionEvents(sessionId, { follow: false, startIndex, signal });
  return new ReadableStream<SessionStreamEvent>({
    async pull(controller) {
      const next = await events.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      await events.return(undefined);
    },
  });
}

/**
 * Reads one session's stored records up to the durable tail observed when the read opens, then
 * ends. Negative `startIndex` values count back from that tail.
 */
export function readSessionRecordHistory(
  sessionId: string,
  startIndex?: number,
): ReadableStream<unknown> {
  let reader: ReadableStreamDefaultReader<unknown> | undefined;
  let position = 0;
  let tailIndex = -1;
  return new ReadableStream<unknown>({
    async start() {
      tailIndex = await readSessionStreamTailIndex(sessionId);
      const requested = startIndex ?? 0;
      position = requested < 0 ? Math.max(0, tailIndex + 1 + requested) : requested;
      if (position <= tailIndex) reader = readSessionRecords(sessionId, position).getReader();
    },
    async pull(controller) {
      if (reader === undefined || position > tailIndex) {
        controller.close();
        await reader?.cancel().catch(() => {});
        return;
      }
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
      position += 1;
    },
    async cancel() {
      await reader?.cancel().catch(() => {});
    },
  });
}

/** Returns the position of the last durably recorded line, or `-1` before the first. */
export async function readSessionStreamTailIndex(sessionId: string): Promise<number> {
  // The readable is never consumed; cancel it so the unread source does not linger.
  const readable = getRun(sessionId).getReadable();
  try {
    const world = await getWorld();
    const [run, tailIndex] = await Promise.all([
      world.runs.get(sessionId, { resolveData: "none" }),
      readable.getTailIndex(),
    ]);
    // Purging can leave chunk records behind; their count does not imply readable data.
    if (run.expiredAt !== undefined && run.expiredAt.getTime() <= Date.now()) {
      throw new RunExpiredError(
        "Session history is no longer available.",
        sessionId,
        run.status,
        run.expiredAt,
      );
    }
    return tailIndex;
  } finally {
    await readable.cancel().catch(() => {});
  }
}

/**
 * Iterates one session's stored lines in process, without the HTTP stream route, with each
 * line's position. A bounded read stops at the tail it observed when it opened: the writer
 * stores one chunk per line, so positions are chunk indexes.
 */
export async function* streamSessionLines(
  sessionId: string,
  options: SessionEventStreamOptions = {},
): AsyncGenerator<PositionedLine, void, undefined> {
  const { follow = true, signal } = options;
  const requestedStartIndex = options.startIndex ?? 0;
  if (signal?.aborted) return;

  let tailIndex: number | undefined;
  let startIndex = requestedStartIndex;
  if (!follow || requestedStartIndex < 0) {
    tailIndex = await readSessionStreamTailIndex(sessionId);
    if (requestedStartIndex < 0) startIndex = Math.max(0, tailIndex + 1 + requestedStartIndex);
  }
  if (!follow && tailIndex !== undefined && startIndex > tailIndex) return;

  const reader = readSessionRecords(sessionId, startIndex).getReader();
  const cancel = () => void reader.cancel(signal?.reason).catch(() => {});
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    let position = startIndex;
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) return;
      yield { line: isStoredLine(value) ? value : undefined, position, record: value };
      if (!follow && tailIndex !== undefined && position >= tailIndex) return;
      position += 1;
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * Iterates one session's events in process, from the lines {@link streamSessionLines} reads.
 * A session an eve before v27 recorded reads as the v27 commits its v26 lines record; see
 * `#execution/v26-history.js`.
 */
export async function* streamSessionEvents(
  sessionId: string,
  options: SessionEventStreamOptions = {},
): AsyncGenerator<SessionStreamEvent, void, undefined> {
  const reader = createEventReader();
  let history: V26HistoryReader | undefined;
  for await (const { line, position, record } of streamSessionLines(sessionId, options)) {
    if (history === undefined && isV26Line(record)) {
      history = createV26HistoryReader();
      // Each v26 line reads in light of those before it.
      if (position > 0) await readV26Prefix(history, sessionId, position, options.signal);
    }
    const read = history === undefined ? line : history.read(record, position);
    if (read !== undefined) yield* reader.read(read, position);
  }
}

async function readV26Prefix(
  history: V26HistoryReader,
  sessionId: string,
  end: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  for await (const { position, record } of streamSessionLines(sessionId, {
    follow: false,
    signal,
    startIndex: 0,
  })) {
    if (position >= end) return;
    history.read(record, position);
  }
}
