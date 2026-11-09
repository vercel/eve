import { ResponseSegment } from "#client/session-utils.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";

/** Reads the commit that admits this delivery through its settlement's whole commit. */
export async function* deliveryEvents(
  source: AsyncIterable<SessionStreamEvent>,
  deliveryId: string,
  signal?: AbortSignal,
  beforeAdmission?: (event: SessionStreamEvent) => void,
): AsyncGenerator<SessionStreamEvent> {
  const segment = new ResponseSegment({ deliveryId });
  let started = false;
  let admittingLine: SessionStreamEvent[] = [];
  for await (const event of source) {
    if (!started) {
      if (event.type === "session.ended")
        throw new Error("The session ended before admitting the accepted delivery.");
      if (admittingLine[0]?.meta.position.line !== event.meta.position.line) {
        for (const earlier of admittingLine) beforeAdmission?.(earlier);
        admittingLine = [];
      }
      admittingLine.push(event);
      if (event.type !== "delivery.admitted" || event.data.deliveryId !== deliveryId) continue;
      started = true;
    }
    const ready = admittingLine.length > 0 ? admittingLine : [event];
    admittingLine = [];
    for (const next of ready) {
      const ended = segment.observe(next);
      yield next;
      if (ended) return;
    }
  }
  if (!signal?.aborted) throw new Error("The stream ended before the accepted delivery settled.");
}
