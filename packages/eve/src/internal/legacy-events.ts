/**
 * Converts session events an application saved before upgrading eve, for history it can't read
 * again from the session's stream. A migration aid, not a stable API: it will be removed.
 */
export { convertLegacyEvents } from "#execution/v26-history.js";
