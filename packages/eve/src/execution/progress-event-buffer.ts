import { MAX_PROGRESS_EVENTS_PER_BATCH, type ProgressEventV1 } from "#protocol/progress.js";

export interface ProgressEventBuffer {
  flush(): Promise<void>;
  push(events: readonly ProgressEventV1[]): Promise<void>;
}

/** Batches deterministic progress events by size and explicit lifecycle boundaries. */
export function createProgressEventBuffer(input: {
  readonly submit: (events: readonly ProgressEventV1[]) => Promise<void>;
}): ProgressEventBuffer {
  const pending: ProgressEventV1[] = [];
  const submitNext = async (count: number): Promise<void> => {
    const events = pending.slice(0, count);
    await input.submit(events);
    pending.splice(0, events.length);
  };
  const flush = async (): Promise<void> => {
    while (pending.length > 0) {
      await submitNext(Math.min(pending.length, MAX_PROGRESS_EVENTS_PER_BATCH));
    }
  };
  return {
    flush,
    async push(events) {
      pending.push(...events);
      while (pending.length >= MAX_PROGRESS_EVENTS_PER_BATCH) {
        await submitNext(MAX_PROGRESS_EVENTS_PER_BATCH);
      }
    },
  };
}
