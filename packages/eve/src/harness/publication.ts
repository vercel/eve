import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { SessionPublication } from "#harness/types.js";

/** The events of one publication, in order. */
export function eventsOf(publication: SessionPublication): readonly UnstampedMessageStreamEvent[] {
  return Array.isArray(publication) ? publication : [publication as UnstampedMessageStreamEvent];
}
