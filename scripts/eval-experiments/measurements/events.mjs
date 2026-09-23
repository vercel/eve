/** @param {string} reason @returns {{ status: "unavailable", reason: string }} */
export function unavailable(reason) {
  return { status: "unavailable", reason };
}

/** Validate and deduplicate event identities before selecting measurement evidence. */
export function captureSessions(sessions) {
  if (!Array.isArray(sessions)) return undefined;

  const bySession = new Map();
  const eventSessions = new Map();
  const identities = new Map();
  for (const session of sessions) {
    if (typeof session?.sessionId !== "string" || !Array.isArray(session.events))
      throw new Error("Unsupported session capture shape.");
    if (bySession.has(session.sessionId))
      throw new Error(`Duplicate session capture: ${session.sessionId}`);
    const events = [];
    for (const event of session.events) {
      if (!event || typeof event.type !== "string" || typeof event.meta?.id !== "string")
        throw new Error("Unsupported event capture shape or missing event identity.");
      const id = event.meta.id;
      const serialized = JSON.stringify(event);
      const earlier = identities.get(id);
      if (earlier !== undefined) {
        if (earlier !== serialized) throw new Error(`Conflicting event identity: ${id}`);
        if (eventSessions.get(id) !== session.sessionId)
          throw new Error(`Ambiguous session evidence for event identity: ${id}`);
        continue;
      }
      identities.set(id, serialized);
      eventSessions.set(id, session.sessionId);
      events.push(event);
    }
    bySession.set(session.sessionId, events);
  }

  return {
    bySession,
    events: [...bySession.values()].flat(),
    sessionId: (event) => eventSessions.get(event.meta.id),
    refs: (events) =>
      events.map((event) => ({
        sessionId: eventSessions.get(event.meta.id),
        eventId: event.meta.id,
      })),
  };
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

export function compareEventTime(left, right) {
  const leftAt = timestamp(left);
  const rightAt = timestamp(right);
  if (leftAt === undefined) return rightAt === undefined ? 0 : 1;
  return rightAt === undefined ? -1 : leftAt - rightAt;
}
