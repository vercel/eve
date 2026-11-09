import type { FactPosition } from "#protocol/session-events/envelope.js";
import type { Fact, Progress } from "#protocol/session-events/facts.js";

/** What a session publishes: v27 facts and progress records. */
export type SessionEvent = Fact | Progress;

/** Where and when a reader read one event back. Never on the wire: readers attach it. */
export interface SessionEventMeta {
  readonly position: FactPosition;
  /** The time of the commit that holds it, or of the latest commit for a progress record. */
  readonly at: string;
  /** False while more known records remain in this line; readers stop only after the commit. */
  readonly endOfLine?: boolean;
  /**
   * Exclusive source-line coverage when a reader consumed later lines that emitted no events.
   * Only on a complete line's last event; its original `position` stays unchanged. Preserve
   * this reader metadata when saving events, rather than deriving coverage from event counts.
   */
  readonly next?: number;
}

/** One event as a reader reads it back. */
export type SessionStreamEvent = SessionEvent & { readonly meta: SessionEventMeta };
