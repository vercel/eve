import type { StampedHandleMessageStreamEvent } from "#protocol/message.js";

/** Remembers which session-stream events have already been consumed. */
export type EventDeduper = {
  /**
   * Records `event` and returns true when it is new — false when its id was
   * already admitted, so the caller should drop it.
   */
  admit(event: StampedHandleMessageStreamEvent): boolean;
  /** Number of ids currently remembered. */
  readonly size: number;
};

/**
 * Creates an {@link EventDeduper} keyed on the durable `meta.id`.
 *
 * Catches a reconnect that overlaps handled events, a rewind to an earlier
 * `startIndex`, and a saved log merged with the prefix a live stream replays.
 * A retried step is not a duplicate: it re-emits under new ids.
 *
 * The window is unbounded because a bounded one cannot survive a rewind past
 * its capacity — the oldest id is already evicted, so re-admitting it evicts
 * the next and the whole replay cascades back in. Callers here retain an
 * object per event anyway; one that retains nothing should bound its reads
 * with the `startIndex` cursor instead.
 */
export function createEventDeduper(): EventDeduper {
  const seen = new Set<string>();

  return {
    admit(event) {
      // Absent on the wire for events persisted before stream version 20,
      // despite being required by `HandleMessageStreamEventMeta`. Admit them:
      // there is nothing to deduplicate on.
      const id: string | undefined = event.meta?.id;
      if (id === undefined) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    },
    get size() {
      return seen.size;
    },
  };
}
