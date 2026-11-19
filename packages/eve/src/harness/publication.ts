import type { SessionEvent } from "#protocol/session-event.js";
import type { SessionPublication } from "#harness/types.js";

export function eventsOf(publication: SessionPublication): readonly SessionEvent[] {
  return Array.isArray(publication) ? publication : [publication as SessionEvent];
}
