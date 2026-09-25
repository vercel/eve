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

/** Sum recorded model costs only when every selected model step has complete evidence. */
export function totalModelCost(capture, turns) {
  const selectedTurns = new Map();
  for (const { sessionId, start } of turns) {
    const ids = selectedTurns.get(sessionId) ?? new Set();
    ids.add(start.data.turnId);
    selectedTurns.set(sessionId, ids);
  }
  const starts = new Map();
  const completions = new Map();
  const observedTurns = new Set();
  for (const [sessionId, turnIds] of selectedTurns) {
    for (const event of capture.bySession.get(sessionId)) {
      if (!["step.started", "step.completed", "step.failed"].includes(event.type)) continue;
      const { turnId, stepIndex } = event.data ?? {};
      if (!turnIds.has(turnId) || !Number.isInteger(stepIndex) || stepIndex < 0)
        return unavailable("missing-model-step-identity");
      if (event.type === "step.failed") return unavailable("failed-model-step");
      const key = JSON.stringify([sessionId, turnId, stepIndex]);
      const indexed = event.type === "step.started" ? starts : completions;
      if (indexed.has(key)) return unavailable("ambiguous-model-step");
      indexed.set(key, event);
      observedTurns.add(JSON.stringify([sessionId, turnId]));
    }
  }
  for (const [sessionId, turnIds] of selectedTurns) {
    for (const turnId of turnIds) {
      if (!observedTurns.has(JSON.stringify([sessionId, turnId])))
        return unavailable("missing-model-steps");
    }
  }
  if (starts.size === 0 && completions.size === 0) return unavailable("missing-model-steps");
  if (starts.size !== completions.size || [...starts.keys()].some((key) => !completions.has(key)))
    return unavailable("incomplete-model-steps");
  let total = 0;
  for (const event of completions.values()) {
    const cost = event.data.usage?.costUsd;
    if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)
      return unavailable("missing-or-invalid-model-cost");
    total += cost;
  }
  if (!Number.isFinite(total)) return unavailable("invalid-total-model-cost");
  return measured(capture, total, [...starts.values(), ...completions.values()]);
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
