import { createUlid, isUlid } from "#shared/ulid.js";

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

/**
 * Returns true when `value` has the shape {@link createEventId} produces.
 *
 * Shape-only: this does not prove eve minted the id.
 */
export function isEventId(value: string): boolean {
  return value.startsWith(EVENT_ID_PREFIX) && isUlid(value.slice(EVENT_ID_PREFIX.length));
}
