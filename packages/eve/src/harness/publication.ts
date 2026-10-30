import type { SessionEvent } from "#protocol/session-event.js";
import type { SessionPublication } from "#harness/types.js";

/** The events of one publication, in order. */
export function eventsOf(publication: SessionPublication): readonly SessionEvent[] {
  return Array.isArray(publication) ? publication : [publication as SessionEvent];
}
