import type { SessionStreamEvent } from "#protocol/session-event.js";
import { parseNdjsonStream } from "#execution/ndjson-stream.js";
import { sessionEventStore, type Hosts } from "#execution/hosts.js";
import { createEventReader } from "#protocol/session-lines.js";
import { createV26HistoryReader, type V26HistoryReader } from "#execution/v26-history.js";
import { isV26Line } from "#protocol/v26-lines.js";
import { isStoredLine, type StoredLine } from "#protocol/session-events/envelope.js";

export interface SessionEventStreamOptions {
  readonly startIndex?: number;
  readonly follow?: boolean;
  readonly signal?: AbortSignal;
}

export interface PositionedLine {
  readonly position: number;
  readonly line: StoredLine | undefined;
  readonly record: unknown;
}

export function readSessionRecords(
  hosts: Hosts,
  sessionId: string,
  startIndex?: number,
): ReadableStream<unknown> {
  return parseNdjsonStream<unknown>(() =>
    sessionEventStore(hosts, sessionId).readable(sessionId, startIndex),
  );
}

export function readSessionEventStream(
  hosts: Hosts,
  sessionId: string,
  startIndex?: number,
  signal?: AbortSignal,
): ReadableStream<SessionStreamEvent> {
  const cancellation = new AbortController();
  const readSignal =
    signal === undefined ? cancellation.signal : AbortSignal.any([signal, cancellation.signal]);
  const lines = streamSessionLines(hosts, sessionId, { startIndex, signal: readSignal });
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
      cancellation.abort();
      await lines.return(undefined);
    },
  });
}

export function readSessionEventHistory(
  hosts: Hosts,
  sessionId: string,
  startIndex?: number,
  signal?: AbortSignal,
): ReadableStream<SessionStreamEvent> {
  const events = streamSessionEvents(hosts, sessionId, { follow: false, startIndex, signal });
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

export function readSessionRecordHistory(
  hosts: Hosts,
  sessionId: string,
  startIndex?: number,
): ReadableStream<unknown> {
  let reader: ReadableStreamDefaultReader<unknown> | undefined;
  let position = 0;
  let tailIndex = -1;
  return new ReadableStream<unknown>({
    async start() {
      tailIndex = await readSessionStreamTailIndex(hosts, sessionId);
      const requested = startIndex ?? 0;
      position = requested < 0 ? Math.max(0, tailIndex + 1 + requested) : requested;
      if (position <= tailIndex)
        reader = readSessionRecords(hosts, sessionId, position).getReader();
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

export async function readSessionStreamTailIndex(hosts: Hosts, sessionId: string): Promise<number> {
  return await sessionEventStore(hosts, sessionId).tail(sessionId);
}

export async function assertSessionHistoryReadable(hosts: Hosts, sessionId: string): Promise<void> {
  await sessionEventStore(hosts, sessionId).assertReadable(sessionId);
}

export async function* streamSessionLines(
  hosts: Hosts,
  sessionId: string,
  options: SessionEventStreamOptions = {},
): AsyncGenerator<PositionedLine, void, undefined> {
  const { follow = true, signal } = options;
  const requestedStartIndex = options.startIndex ?? 0;
  if (signal?.aborted) return;

  let tailIndex: number | undefined;
  let startIndex = requestedStartIndex;
  if (!follow || requestedStartIndex < 0) {
    tailIndex = await readSessionStreamTailIndex(hosts, sessionId);
    if (requestedStartIndex < 0) startIndex = Math.max(0, tailIndex + 1 + requestedStartIndex);
  }
  if (!follow && tailIndex !== undefined && startIndex > tailIndex) return;

  const reader = readSessionRecords(hosts, sessionId, startIndex).getReader();
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

export async function* streamSessionEvents(
  hosts: Hosts,
  sessionId: string,
  options: SessionEventStreamOptions = {},
): AsyncGenerator<SessionStreamEvent, void, undefined> {
  const reader = createEventReader();
  let history: V26HistoryReader | undefined;
  for await (const { line, position, record } of streamSessionLines(hosts, sessionId, options)) {
    if (history === undefined && isV26Line(record)) {
      history = createV26HistoryReader();
      if (position > 0) await readV26Prefix(hosts, history, sessionId, position, options.signal);
    }
    const read = history === undefined ? line : history.read(record, position);
    if (read !== undefined) yield* reader.read(read, position);
  }
}

async function readV26Prefix(
  hosts: Hosts,
  history: V26HistoryReader,
  sessionId: string,
  end: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  for await (const { position, record } of streamSessionLines(hosts, sessionId, {
    follow: false,
    signal,
    startIndex: 0,
  })) {
    if (position >= end) return;
    history.read(record, position);
  }
}
