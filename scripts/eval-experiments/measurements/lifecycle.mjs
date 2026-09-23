import { selectEvents, unavailable } from "./events.mjs";

/** Resolve selected calls to child sessions and verify their initial invocation. */
export function delegatedSessions(capture, calls) {
  if (calls.length === 0) return unavailable("missing-delegation");
  const children = new Map();
  for (const called of calls) {
    const parentSessionId = capture.sessionId(called);
    const { childSessionId, turnId: parentTurnId, callId } = called.data ?? {};
    if (![childSessionId, parentTurnId, callId].every((value) => typeof value === "string"))
      return unavailable("missing-delegation-identities");
    if (childSessionId === parentSessionId) return unavailable("child-session-reused");
    if (!capture.bySession.has(childSessionId)) return unavailable("missing-child-capture");

    const child = children.get(childSessionId) ?? { parentSessionId, calls: [] };
    if (child.parentSessionId !== parentSessionId) return unavailable("ambiguous-child-parent");
    child.calls.push({ callId, parentTurnId });
    children.set(childSessionId, child);
  }

  for (const [sessionId, child] of children) {
    const invocations = selectEvents(capture.bySession.get(sessionId), "session.started");
    const invocation = invocations[0]?.data?.invocation;
    const initialCall = child.calls[0];
    if (
      invocations.length !== 1 ||
      invocation?.kind !== "subagent" ||
      invocation.parentCallId !== initialCall.callId ||
      invocation.parentSessionId !== child.parentSessionId ||
      invocation.parentTurnId !== initialCall.parentTurnId
    )
      return unavailable("child-invocation-mismatch");
  }
  return { status: /** @type {const} */ ("ready"), sessionIds: [...children.keys()] };
}

/** Require a unique parent turn start for each selected delegation. */
export function parentTurnStarts(capture, calls) {
  const starts = [];
  for (const called of calls) {
    const matches = selectEvents(capture.bySession.get(capture.sessionId(called)), "turn.started", {
      turnId: called.data.turnId,
    });
    if (matches.length !== 1)
      return unavailable(
        matches.length > 1 ? "ambiguous-parent-turn-start" : "missing-parent-turn-start",
      );
    starts.push(matches[0]);
  }
  return { status: /** @type {const} */ ("ready"), events: starts };
}

/** Pair every turn in selected sessions; partial or ambiguous captures are unavailable. */
export function completedTurns(capture, sessionIds, { subject = "turn" } = {}) {
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
      const completions = selectEvents(events, "turn.completed", { turnId });
      if (completions.length !== 1)
        return unavailable(
          completions.length > 1 ? `ambiguous-${subject}` : `${subject}-incomplete`,
        );
      completedIds.add(turnId);
      turns.push({ sessionId, start, completed: completions[0], events });
    }
    if (
      selectEvents(events, "turn.completed").some((event) => !completedIds.has(event.data?.turnId))
    )
      return unavailable(`${subject}-start-missing`);
  }
  return { status: /** @type {const} */ ("ready"), turns };
}
