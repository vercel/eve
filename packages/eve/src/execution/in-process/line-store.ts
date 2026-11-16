import type { SessionLineStore } from "#execution/session-line-store.js";

// Session streams kept in memory: each write is one line, as the session's writer writes one
// chunk per line. Readers follow a stream until its writer closes it. Nothing survives the
// process.

interface MemoryStream {
  readonly chunks: Uint8Array[];
  closed: boolean;
  readonly waiters: Set<() => void>;
}

export interface MemoryLineStore extends SessionLineStore {
  /** Opens `sessionId`'s stream and returns the writable its writer writes lines to. */
  open(sessionId: string): WritableStream<Uint8Array>;
  /** The sessions this store holds a stream for. */
  sessions(): readonly string[];
}

export function createMemoryLineStore(): MemoryLineStore {
  const streams = new Map<string, MemoryStream>();
  const streamOf = (sessionId: string): MemoryStream => {
    const stream = streams.get(sessionId);
    if (stream === undefined) throw new Error(`Session "${sessionId}" has no stream here.`);
    return stream;
  };
  const wake = (stream: MemoryStream): void => {
    for (const resolve of stream.waiters) resolve();
    stream.waiters.clear();
  };

  return {
    sessions: () => [...streams.keys()],
    async assertReadable(sessionId) {
      streamOf(sessionId);
    },
    async tail(sessionId) {
      return streamOf(sessionId).chunks.length - 1;
    },
    open(sessionId) {
      if (streams.has(sessionId)) throw new Error(`Session "${sessionId}" already has a stream.`);
      const stream: MemoryStream = { chunks: [], closed: false, waiters: new Set() };
      streams.set(sessionId, stream);
      return new WritableStream<Uint8Array>({
        write(chunk) {
          // The writer may reuse its buffer; the stream keeps what was written.
          stream.chunks.push(chunk.slice());
          wake(stream);
        },
        close() {
          stream.closed = true;
          wake(stream);
        },
      });
    },
    readable(sessionId, startIndex = 0) {
      const stream = streamOf(sessionId);
      let next = startIndex < 0 ? Math.max(0, stream.chunks.length + startIndex) : startIndex;
      let cancelled = false;
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          while (!cancelled) {
            const chunk = stream.chunks[next];
            if (chunk !== undefined) {
              next += 1;
              controller.enqueue(chunk);
              return;
            }
            if (stream.closed) {
              controller.close();
              return;
            }
            await new Promise<void>((resolve) => stream.waiters.add(resolve));
          }
        },
        cancel() {
          cancelled = true;
          wake(stream);
        },
      });
    },
  };
}
