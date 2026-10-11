import { parseNdjsonStream } from "#execution/ndjson-stream.js";
import { getRun } from "#internal/workflow/runtime.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import {
  normalizePersistedMessageStreamEvent,
  type MessageStreamEventForVersion,
  type MessageStreamVersion,
} from "#protocol/message-version.js";

/** Options for {@link streamSessionEvents}. */
export interface SessionEventStreamOptions {
  /**
   * Zero-based index of the first event to read. Negative values count back
   * from the durable tail (`-1` is the latest event). Defaults to `0`.
   */
  readonly startIndex?: number;
  /**
   * Whether to keep following events recorded after the read opens. When
   * `false`, the read ends at the durable tail observed when it opens.
   * Defaults to `true`.
   */
  readonly follow?: boolean;
  /** Stops the read and releases the underlying stream reader. */
  readonly signal?: AbortSignal;
}

/**
 * Reads one session's durable event stream. Negative `startIndex` values count
 * back from the tail.
 */
export function readSessionEventStream(
  sessionId: string,
  startIndex?: number,
): ReadableStream<MessageStreamEvent> {
  return parseNdjsonStream<MessageStreamEvent>(
    () => getRun(sessionId).getReadable({ startIndex }),
    normalizePersistedEvent,
  );
}

/**
 * Reads one session's recorded events up to the durable tail observed when
 * the read opens, then ends. Negative `startIndex` values count back from
 * that tail.
 */
export function readSessionEventHistory(
  sessionId: string,
  startIndex?: number,
): ReadableStream<MessageStreamEvent> {
  const events = streamSessionEvents(sessionId, { follow: false, startIndex });
  return new ReadableStream<MessageStreamEvent>({
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

/** Returns the index of the last durably recorded event, or `-1` before the first. */
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
 * Iterates one session's durable events in process, without the HTTP stream
 * route.
 *
 * A bounded read counts events up from `startIndex` to find the tail. That
 * holds because the writer persists exactly one chunk per event (see
 * `createOrderedStreamEmitter`).
 */
export async function* streamSessionEvents(
  sessionId: string,
  options: SessionEventStreamOptions = {},
): AsyncGenerator<MessageStreamEvent, void, undefined> {
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

  const reader = readSessionEventStream(sessionId, startIndex).getReader();
  const cancel = () => void reader.cancel(signal?.reason).catch(() => {});
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    let index = startIndex;
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
      if (!follow && tailIndex !== undefined && index >= tailIndex) return;
      index += 1;
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function normalizePersistedEvent(value: unknown): MessageStreamEvent {
  return normalizePersistedMessageStreamEvent(
    value as MessageStreamEventForVersion<MessageStreamVersion>,
  );
}
