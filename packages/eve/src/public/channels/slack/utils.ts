const MAX_HANDLED_EVENTS = 10_000;

export function markEventHandled(eventId: string, handledEvents: Set<string>): void {
  handledEvents.add(eventId);
  if (handledEvents.size > MAX_HANDLED_EVENTS) {
    while (handledEvents.size > MAX_HANDLED_EVENTS / 2) {
      handledEvents.delete(handledEvents.values().next().value!);
    }
  }
}
