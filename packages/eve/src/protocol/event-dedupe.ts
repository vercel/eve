import type { StampedHandleMessageStreamEvent } from "#protocol/message.js";

/** Remembers which session-stream events have already been consumed. */
export type EventDeduper = {
  /** Records `event` and reports whether it had already been recorded. */
  isDuplicate(event: StampedHandleMessageStreamEvent): boolean;
  /** Number of ids currently remembered. */
  readonly size: number;
};

/**
 * Creates an {@link EventDeduper} keyed on the durable `meta.id`.
 *
 * The window is unbounded on purpose. A bounded one cannot survive a rewind
 * past its capacity: the oldest id has already been evicted, so re-admitting
 * it evicts the next, and the whole replay cascades back in. Every caller
 * already retains at least one object per event, so a set of ids costs
 * strictly less than the state it guards.
 */
export function createEventDeduper(): EventDeduper {
  const seen = new Set<string>();

  return {
    isDuplicate(event) {
      // An agent older than stream version 20 sends no envelope, so this can
      // be absent on the wire despite the type. Admit those events rather
      // than throwing on a cross-version stream.
      const id: string | undefined = event.meta?.id;
      if (id === undefined) return false;
      if (seen.has(id)) return true;
      seen.add(id);
      return false;
    },
    get size() {
      return seen.size;
    },
  };
}
