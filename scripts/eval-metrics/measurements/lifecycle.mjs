import { selectEvents, unavailable } from "./events.mjs";

/**
 * Pair every turn in selected sessions with its terminal event; partial or
 * ambiguous captures are unavailable. `terminalTypes` widens the accepted
 * terminals, e.g. to include failed and cancelled turns.
 */
export function completedTurns(
  capture,
  sessionIds,
  { subject = "turn", terminalTypes = ["turn.completed"] } = {},
) {
  const terminals = (events, data) =>
    terminalTypes.flatMap((type) => selectEvents(events, type, data));
  const turns = [];
  for (const sessionId of sessionIds) {
    const events = capture.bySession.get(sessionId);
    const starts = selectEvents(events, "turn.started");
    if (starts.length === 0) return unavailable(`missing-${subject}`);
    const completedIds = new Set();
    for (const start of starts) {
      const turnId = start.data?.turnId;
      if (typeof turnId !== "string") return unavailable(`missing-${subject}-identity`);
      if (completedIds.has(turnId)) return unavailable(`ambiguous-${subject}`);
      const completions = terminals(events, { turnId });
      if (completions.length !== 1)
        return unavailable(
          completions.length > 1 ? `ambiguous-${subject}` : `${subject}-incomplete`,
        );
      completedIds.add(turnId);
      turns.push({ sessionId, start, completed: completions[0], events });
    }
    if (terminals(events).some((event) => !completedIds.has(event.data?.turnId)))
      return unavailable(`${subject}-start-missing`);
  }
  return { status: /** @type {const} */ ("ready"), turns };
}
