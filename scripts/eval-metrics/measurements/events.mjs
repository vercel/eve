import { isLegacyCapture, upgradeLegacyEvents } from "./legacy.mjs";

/**
 * @typedef {{ status: "measured", value: number }
 *   | { status: "unavailable" | "not-applicable", reason: string }} Measurement
 */

/** @param {string} reason @returns {{ status: "unavailable", reason: string }} */
export function unavailable(reason) {
  return { status: "unavailable", reason };
}

/** @param {string} reason @returns {{ status: "not-applicable", reason: string }} */
export function notApplicable(reason) {
  return { status: "not-applicable", reason };
}

/** Records that preview a value a fact completes (session-events/facts.ts `Progress`). */
const PROGRESS_TYPES = new Set(["content.delta", "call.input", "call.progress"]);

/**
 * An event's identity: its position in its session's stream, so the same
 * position in two sessions is two events. Pre-v27 events carry a globally
 * unique `meta.id` instead, which events upgraded from them keep.
 */
export function eventKey(sessionId, event) {
  if (typeof event?.meta?.id === "string") return event.meta.id;
  const position = event?.meta?.position;
  return Number.isInteger(position?.line) && Number.isInteger(position?.index)
    ? `${sessionId}@${position.line}:${position.index}`
    : undefined;
}

/**
 * Whether `meta.at` is when the event was written. A v27 progress record has
 * no time of its own: readers give it the time of the latest commit before it.
 */
export function hasOwnTime(event) {
  return typeof event?.meta?.id === "string" || !PROGRESS_TYPES.has(event?.type);
}

/** One captured session's events in the v27 vocabulary, upgrading a pre-v27 capture. */
export function sessionEvents(session) {
  const events = Array.isArray(session?.events) ? session.events : [];
  return isLegacyCapture(events) ? upgradeLegacyEvents(events) : events;
}

/**
 * Merge repeated session captures and validate event identities before
 * measuring. Events come back in the v27 vocabulary.
 */
export function captureSessions(sessions) {
  if (!Array.isArray(sessions)) return undefined;

  const bySession = new Map();
  const identities = new Map();
  const eventSessions = new Map();
  for (const session of sessions) {
    if (typeof session?.sessionId !== "string" || !Array.isArray(session.events))
      throw new Error("Unsupported session capture shape.");
    const events = bySession.get(session.sessionId) ?? [];
    for (const event of session.events) {
      const key = eventKey(session.sessionId, event);
      if (typeof event?.type !== "string" || key === undefined)
        throw new Error("Unsupported event capture shape or missing event identity.");
      // A v27 reader attaches `meta` per read (`endOfLine` varies), so only the record identifies it.
      const record = JSON.stringify(
        typeof event.meta.id === "string" ? event : { type: event.type, data: event.data },
      );
      const earlier = identities.get(key);
      if (earlier !== undefined) {
        if (earlier !== record) throw new Error(`Conflicting event identity: ${key}`);
        if (eventSessions.get(key) !== session.sessionId)
          throw new Error(`Ambiguous session evidence for event identity: ${key}`);
        continue;
      }
      identities.set(key, record);
      eventSessions.set(key, session.sessionId);
      events.push(event);
    }
    bySession.set(session.sessionId, events);
  }
  for (const [sessionId, events] of bySession) bySession.set(sessionId, sessionEvents({ events }));

  return { bySession, events: [...bySession.values()].flat() };
}

/** Match an event type and exact data fields, preserving capture order. */
export function selectEvents(events, type, data = {}) {
  return events.filter(
    (event) =>
      event.type === type &&
      Object.entries(data).every(([key, value]) => event.data?.[key] === value),
  );
}

export function timestamp(event) {
  const value = Date.parse(event?.meta?.at ?? "");
  return Number.isFinite(value) ? value : undefined;
}
