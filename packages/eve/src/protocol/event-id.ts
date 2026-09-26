import { createUlid } from "#shared/ulid.js";

/** Prefix stamped on every eve session stream event id. */
export const EVENT_ID_PREFIX = "evt_";

/**
 * Mints the id carried on one session stream event's `meta.id`:
 * {@link EVENT_ID_PREFIX} followed by a ULID.
 *
 * See `#shared/ulid.js` for the ordering guarantee — it holds within a
 * process, not across the separate steps of one session.
 */
export function createEventId(): string {
  return `${EVENT_ID_PREFIX}${createUlid()}`;
}
