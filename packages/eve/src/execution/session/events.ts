import { parseNdjsonStream } from "#execution/ndjson-stream.js";
import type { EventStreamRef } from "#execution/session/resources.js";
import {
  appendStreamRecords,
  readStream,
  streamTailIndex,
  withStreamWriter,
} from "#execution/session/stream-storage.js";
import { encodeMessageStreamEvent, type MessageStreamEvent } from "#protocol/message.js";

export const sessionEvents = {
  append(ref: EventStreamRef, events: readonly MessageStreamEvent[]): Promise<void> {
    return appendStreamRecords(ref.id, events.map(encodeMessageStreamEvent));
  },

  read(
    ref: EventStreamRef,
    options?: { readonly startIndex?: number },
  ): ReadableStream<MessageStreamEvent> {
    return parseNdjsonStream(() => readStream<Uint8Array>(ref.id, options?.startIndex));
  },

  tailIndex(ref: EventStreamRef): Promise<number> {
    return streamTailIndex(ref.id);
  },

  withWriter<Result>(
    ref: EventStreamRef,
    run: (writable: WritableStream<Uint8Array>) => Promise<Result>,
  ): Promise<Result> {
    return withStreamWriter(ref.id, run);
  },

  close(ref: EventStreamRef): Promise<void> {
    return appendStreamRecords(ref.id, [], true);
  },
};
