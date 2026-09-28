import { EVENT_ID_PREFIX } from "#protocol/event-id.js";

const ULID_SHAPE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;

/**
 * Returns true when `value` has the shape `createEventId` produces: the event
 * id prefix followed by a Crockford base32 ULID.
 *
 * Shape-only: this does not prove eve minted the id.
 */
export function isEventId(value: string): boolean {
  return value.startsWith(EVENT_ID_PREFIX) && ULID_SHAPE.test(value.slice(EVENT_ID_PREFIX.length));
}
