import type { SessionStreamEvent } from "#protocol/session-event.js";

/** Remembers which session-stream events have already been consumed. */
type EventDeduper = {
  /**
   * Records `event` and returns true when it is new — false when its id was
   * already admitted, so the caller should drop it.
   */
  admit(event: SessionStreamEvent): boolean;
  /** Number of ids currently remembered. */
  readonly size: number;
};

/**
 * Creates an {@link EventDeduper} keyed on each event's position.
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
      // A record's position is its identity: its line, and its index in the line. A reader
      // without one has nothing to deduplicate on.
      const position = event.meta?.position;
      if (position === undefined) return true;
      const id = `${String(position.line)}.${String(position.index)}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    },
    get size() {
      return seen.size;
    },
  };
}
