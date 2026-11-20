import type { SessionLineStore } from "#execution/session-line-store.js";

interface MemoryStream {
  readonly chunks: Uint8Array[];
  closed: boolean;
  readonly waiters: Set<() => void>;
}

export interface MemoryLineStore extends SessionLineStore {
  open(sessionId: string): WritableStream<Uint8Array>;
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
