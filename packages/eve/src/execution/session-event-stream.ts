import { parseNdjsonStream } from "#execution/ndjson-stream.js";
import { getRun } from "#internal/workflow/runtime.js";
import { createLegacyEventReader } from "#protocol/legacy-lines.js";
import type { MessageStreamEvent } from "#protocol/message.js";
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
 * Reads one session's v26 events: the records each line carries, rebuilt as v26 readers expect
 * them. Kept while v26 event types ride inside lines.
 */
export function readSessionEventStream(
  sessionId: string,
  startIndex?: number,
): ReadableStream<MessageStreamEvent> {
  const lines = streamSessionLines(sessionId, { startIndex });
  const reader = createLegacyEventReader();
  return new ReadableStream<MessageStreamEvent>({
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
      await lines.return(undefined);
    },
  });
}

/** Returns the position of the last durably recorded line, or `-1` before the first. */
export async function readSessionStreamTailIndex(sessionId: string): Promise<number> {
  // The readable is never consumed; cancel it so the unread source does not linger.
  const readable = getRun(sessionId).getReadable();
  try {
    return await readable.getTailIndex();
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
      yield { line: isStoredLine(value) ? value : undefined, position };
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
 * Iterates one session's v26 events in process, from the lines {@link streamSessionLines}
 * reads. Kept while v26 event types ride inside lines.
 */
export async function* streamSessionEvents(
  sessionId: string,
  options: SessionEventStreamOptions = {},
): AsyncGenerator<MessageStreamEvent, void, undefined> {
  const reader = createLegacyEventReader();
  for await (const { line, position } of streamSessionLines(sessionId, options)) {
    if (line !== undefined) yield* reader.read(line, position);
  }
}
