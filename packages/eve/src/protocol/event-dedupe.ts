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
 * Re-delivery is not only a reconnect concern. Stream writes are batched, and
 * a batch that fails partway can re-send pages that already landed, so the
 * durable log itself can hold the same chunk twice — callers need this even
 * when they never rewind.
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
      // `meta.id` arrived in stream version 20; `meta.at` predates it. An
      // event written by an older agent still carries the envelope but no id,
      // so this is absent on the wire despite the type. Admit those rather
      // than dropping a whole legacy replay.
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
