import type { SessionLineStore } from "#execution/session-line-store.js";

// Session streams kept in memory: each write is one line, as the session's writer writes one
// chunk per line. Readers follow a stream until its writer closes it. What survives the process
// is what `persist` kept.
//
// With `persist`, a reader sees a line only once it's kept, and lines are kept in batches: a line
// written while a batch is being kept waits for the next one, so a store far away (a remote
// World, at hundreds of milliseconds a write) keeps a streamed reply in a few writes, not one per
// line. A write resolves at once, except a barrier's (`isBarrier`: a line that must be kept
// before the writer goes on, such as a call's start before the tool runs), which resolves once
// it and everything before it are kept. `flush` waits for every line written so far.

interface MemoryStream {
  /** The lines readers see: those kept. */
  readonly chunks: Uint8Array[];
  closed: boolean;
  readonly waiters: Set<() => void>;
  /** Keeps what was written and not yet kept; resolves once it's kept. */
  flush: () => Promise<void>;
}

export interface MemoryLineStore extends SessionLineStore {
  /**
   * Opens `sessionId`'s stream and returns the writable its writer writes lines to. A restored
   * session's stream starts with the lines it recorded before. With `persist`, lines are kept in
   * batches, each at the position of its first line, and no reader sees a line a store didn't
   * keep. A write that fails to be kept fails the writes after it.
   */
  open(
    sessionId: string,
    recorded?: readonly Uint8Array[],
    persist?: (position: number, lines: readonly Uint8Array[]) => Promise<void>,
    isBarrier?: (line: Uint8Array) => boolean,
  ): WritableStream<Uint8Array>;
  /** Resolves once every line written to `sessionId`'s stream so far is kept. */
  flush(sessionId: string): Promise<void>;
  /** `flush` for every stream. */
  flushAll(): Promise<void>;
  /** Every line `sessionId`'s stream holds so far. */
  recorded(sessionId: string): readonly Uint8Array[];
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
    flush: async (sessionId) => await streams.get(sessionId)?.flush(),
    async flushAll() {
      await Promise.all([...streams.values()].map((stream) => stream.flush()));
    },
    async assertReadable(sessionId) {
      streamOf(sessionId);
    },
    async tail(sessionId) {
      return streamOf(sessionId).chunks.length - 1;
    },
    recorded: (sessionId) => [...streamOf(sessionId).chunks],
    open(sessionId, recorded = [], persist, isBarrier) {
      if (streams.has(sessionId)) throw new Error(`Session "${sessionId}" already has a stream.`);
      const pending: Uint8Array[] = [];
      let keeping: Promise<void> = Promise.resolve();
      let scheduled = false;
      let failure: { readonly error: unknown } | undefined;
      // One batch at a time, in order: whatever is pending when the batch before it is kept.
      const keepPending = async (): Promise<void> => {
        scheduled = false;
        if (failure !== undefined || pending.length === 0) return;
        const batch = pending.splice(0);
        try {
          await persist!(stream.chunks.length, batch);
        } catch (error) {
          failure = { error };
          throw error;
        }
        stream.chunks.push(...batch);
        wake(stream);
      };
      const schedule = (): Promise<void> => {
        if (!scheduled) {
          scheduled = true;
          keeping = keeping.then(keepPending, keepPending);
        }
        return keeping;
      };
      const stream: MemoryStream = {
        chunks: [...recorded],
        closed: false,
        waiters: new Set(),
        flush: async () => {
          if (persist === undefined) return;
          if (pending.length > 0) schedule();
          await keeping;
          if (failure !== undefined) throw failure.error;
        },
      };
      streams.set(sessionId, stream);
      return new WritableStream<Uint8Array>({
        async write(chunk) {
          // The writer may reuse its buffer; the stream keeps what was written.
          const line = chunk.slice();
          if (persist === undefined) {
            stream.chunks.push(line);
            wake(stream);
            return;
          }
          if (failure !== undefined) throw failure.error;
          pending.push(line);
          const kept = schedule();
          // Not awaited unless it's a barrier: a failed batch fails the next write, or a flush.
          kept.catch(() => {});
          if (isBarrier?.(line)) await stream.flush();
        },
        async close() {
          await stream.flush();
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
