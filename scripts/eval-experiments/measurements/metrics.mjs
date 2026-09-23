import { compareEventTime, selectEvents, timestamp, unavailable } from "./events.mjs";

/** @returns {import('../types.ts').Measurement} */
function measured(capture, value, events) {
  return { status: "measured", value, evidence: capture.refs(events) };
}

/** Span from the earliest start to the latest completion, including gaps between turns. */
export function elapsedTime(
  capture,
  starts,
  completions,
  { evidence = [], missingReason = "missing-timestamp" } = {},
) {
  const sortedStarts = [...starts].sort(compareEventTime);
  const sortedCompletions = [...completions].sort(compareEventTime);
  const startAt = timestamp(sortedStarts[0]);
  const endAt = timestamp(sortedCompletions.at(-1));
  if (startAt === undefined || endAt === undefined) return unavailable(missingReason);
  if (endAt < startAt) return unavailable("negative-duration");
  return measured(capture, endAt - startAt, [...sortedStarts, ...evidence, ...sortedCompletions]);
}

/** Sum paired turn durations, excluding gaps and counting overlapping turns separately. */
export function totalTurnDuration(capture, turns, { missingReason = "missing-timestamp" } = {}) {
  let total = 0;
  const evidence = [];
  for (const { start, completed } of turns) {
    const startAt = timestamp(start);
    const endAt = timestamp(completed);
    if (startAt === undefined || endAt === undefined) return unavailable(missingReason);
    if (endAt < startAt) return unavailable("negative-duration");
    total += endAt - startAt;
    evidence.push(start, completed);
  }
  return measured(capture, total, evidence);
}

/** Count distinct requested tool calls per session within the selected turns. */
export function totalToolCalls(capture, turns) {
  const ids = new Set();
  const evidence = turns.flatMap(({ start, completed }) => [start, completed]);
  for (const { sessionId, start, events } of turns) {
    for (const event of selectEvents(events, "actions.requested", { turnId: start.data.turnId })) {
      if (!Array.isArray(event.data.actions)) return unavailable("missing-tool-call-identity");
      evidence.push(event);
      for (const action of event.data.actions) {
        if (action?.kind !== "tool-call") continue;
        if (typeof action.callId !== "string" || !action.callId)
          return unavailable("missing-tool-call-identity");
        ids.add(`${sessionId}\0${action.callId}`);
      }
    }
  }
  return measured(capture, ids.size, evidence);
}
