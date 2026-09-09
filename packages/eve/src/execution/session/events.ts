import { parseNdjsonStream } from "#execution/ndjson-stream.js";
import type { EventStreamRef } from "#execution/session/resources.js";
import {
  appendStreamRecords,
  readStream,
  streamTailIndex,
  withStreamWriter,
} from "#execution/session/stream-storage.js";
import { encodeMessageStreamEvent, type MessageStreamEvent } from "#protocol/message.js";
import { createSessionEventWriter } from "#execution/session/event-writer.js";
import { background } from "#internal/workflow/background.js";

export const sessionEvents = {
  append(ref: EventStreamRef, events: readonly MessageStreamEvent[]): Promise<void> {
    return sessionEvents.withWriter(ref, async (writable) => {
      const writer = writable.getWriter();
      try {
        for (const event of events) await writer.write(encodeMessageStreamEvent(event));
      } finally {
        writer.releaseLock();
      }
    });
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

  async withWriter<Result>(
    ref: EventStreamRef,
    run: (writable: WritableStream<Uint8Array>, failureSignal: AbortSignal) => Promise<Result>,
  ): Promise<Result> {
    const writer = createSessionEventWriter((consume) => withStreamWriter(ref.id, consume));
    let outcome: { value: Result } | { error: unknown };
    try {
      outcome = { value: await run(writer.writable, writer.failureSignal) };
    } catch (error) {
      outcome = { error };
    }
    const flush = writer.finish();
    background(flush);
    try {
      await flush;
    } catch (error) {
      if ("error" in outcome && outcome.error !== error)
        throw new AggregateError([outcome.error, error], "Session event work and flush failed.");
      throw error;
    }
    if ("error" in outcome) throw outcome.error;
    return outcome.value;
  },

  close(ref: EventStreamRef): Promise<void> {
    return appendStreamRecords(ref.id, [], true);
  },
};
