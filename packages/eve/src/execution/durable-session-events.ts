import type { Durable } from "#execution/durable.js";
import type { SessionEventStore } from "#execution/session-event-store.js";

const encoder = new TextEncoder();

export function durableSessionEvents(durable: Durable): SessionEventStore {
  return {
    async assertFollowable(sessionId) {
      if ((await durable.status(sessionId)) === undefined)
        throw new Error(`Session "${sessionId}" isn't in the durable engine.`);
    },
    tail: (sessionId) => durable.tail(sessionId),
    readable(sessionId, startIndex = 0) {
      const lines = durable.readStream(sessionId, startIndex)[Symbol.asyncIterator]();
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          const next = await lines.next();
          if (next.done) controller.close();
          else controller.enqueue(encoder.encode(`${next.value.line}\n`));
        },
        cancel() {
          void lines.return?.();
        },
      });
    },
  };
}
