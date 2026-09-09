/** Event producers await only local enqueueing, never storage backpressure. */
export interface SessionEventWriter {
  readonly writable: WritableStream<Uint8Array>;
  readonly failureSignal: AbortSignal;
  finish(): Promise<void>;
}

const MAX_PENDING_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_EVENTS = 4096;

/** One storage contributor owns the FIFO drain and releases it only after all events persist. */
export function createSessionEventWriter(
  persist: (consume: (writable: WritableStream<Uint8Array>) => Promise<void>) => Promise<void>,
): SessionEventWriter {
  const failure = new AbortController();
  const pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let pendingEvents = 0;
  let sealed = false;
  let wake: (() => void) | undefined;
  let draining: Promise<void> | undefined;
  let finishing: Promise<void> | undefined;
  let controller: WritableStreamDefaultController;

  function fail(error: unknown): void {
    if (failure.signal.aborted) return;
    failure.abort(error);
    controller.error(error);
    pending.length = 0;
    wake?.();
  }

  function drive(): void {
    draining ??= Promise.resolve()
      .then(() =>
        persist(async (stream) => {
          const writer = stream.getWriter();
          try {
            while (true) {
              failure.signal.throwIfAborted();
              const batch = pending.splice(0);
              if (batch.length > 0) {
                // Keep one SDK chunk per event: public startIndex counts these chunks.
                await Promise.all(batch.map((bytes) => writer.write(bytes)));
                pendingBytes -= batch.reduce((total, bytes) => total + bytes.byteLength, 0);
                pendingEvents -= batch.length;
              } else if (sealed) {
                return;
              } else {
                await new Promise<void>((resolve) => {
                  wake = resolve;
                });
                wake = undefined;
              }
            }
          } finally {
            writer.releaseLock();
          }
        }),
      )
      .catch((error) => {
        fail(error);
        throw error;
      });
    // The producer observes failures through its abort signal and finish barrier.
    void draining.catch(() => {});
  }

  const writable = new WritableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    write(bytes) {
      failure.signal.throwIfAborted();
      if (sealed) throw new Error("Session event writer is finished.");
      if (
        pendingBytes + bytes.byteLength > MAX_PENDING_BYTES ||
        pendingEvents >= MAX_PENDING_EVENTS
      ) {
        const error = new Error("Session event writer buffer capacity exceeded.");
        fail(error);
        throw error;
      }
      pending.push(bytes.slice());
      pendingBytes += bytes.byteLength;
      pendingEvents++;
      drive();
      wake?.();
    },
    abort(reason) {
      fail(reason);
    },
  });

  return {
    writable,
    failureSignal: failure.signal,
    finish() {
      finishing ??= (async () => {
        if (writable.locked) {
          fail(new Error("Session event writer must be released before finishing."));
        } else if (!failure.signal.aborted) {
          await writable.close();
        }
        sealed = true;
        wake?.();
        await draining;
        failure.signal.throwIfAborted();
      })();
      return finishing;
    },
  };
}
