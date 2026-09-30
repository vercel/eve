import { parseNdjsonStream } from "#execution/ndjson-stream.js";
import { getRun } from "#internal/workflow/runtime.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import {
  normalizePersistedMessageStreamEvent,
  type MessageStreamEventForVersion,
  type MessageStreamVersion,
} from "#protocol/message-version.js";

const READ_TIMEOUT_MS = 5_000;

/** A bounded run of a session's stream events, and where the next read starts. */
export interface SessionEventsPage {
  readonly events: readonly MessageStreamEvent[];
  readonly nextIndex: number;
  /** Whether the page reached the stream's tail as it stood when the read began. */
  readonly caughtUp: boolean;
}

/**
 * Reads at most `limit` events of a local session's stream from `startIndex`,
 * never past the tail it saw at the start, so reading a parked session never
 * waits for events it hasn't written.
 */
export async function readSessionEvents(input: {
  readonly limit: number;
  readonly sessionId: string;
  readonly startIndex: number;
}): Promise<SessionEventsPage> {
  const run = getRun(input.sessionId);
  const probe = run.getReadable();
  let tailIndex: number;
  try {
    tailIndex = await probe.getTailIndex();
  } finally {
    await probe.cancel().catch(() => {});
  }
  const last = Math.min(tailIndex, input.startIndex + input.limit - 1);
  if (last < input.startIndex) {
    return { caughtUp: true, events: [], nextIndex: input.startIndex };
  }
  const reader = parseNdjsonStream<MessageStreamEvent>(
    () => run.getReadable({ startIndex: input.startIndex }),
    (value) =>
      normalizePersistedMessageStreamEvent(
        value as MessageStreamEventForVersion<MessageStreamVersion>,
      ),
  ).getReader();
  const events: MessageStreamEvent[] = [];
  try {
    while (input.startIndex + events.length <= last) {
      const next = await readWithin(reader, READ_TIMEOUT_MS);
      if (next.done) break;
      events.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const nextIndex = input.startIndex + events.length;
  return { caughtUp: nextIndex > tailIndex, events, nextIndex };
}

async function readWithin<T>(
  reader: ReadableStreamDefaultReader<T>,
  ms: number,
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<T>["read"]>>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Session stream read timed out.")), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
