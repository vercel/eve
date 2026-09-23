export function deriveSelfModificationLifecycle(sessions) {
  /** @param {string} reason @returns {import('../types.ts').Measurement} */
  const unavailable = (reason) => ({
    status: /** @type {const} */ ("unavailable"),
    reason,
  });
  const unavailableMetrics = (reason) => ({
    parentTurnToFinalChildCompletion: unavailable(reason),
    totalChildDuration: unavailable(reason),
    toolCalls: unavailable(reason),
  });
  if (!Array.isArray(sessions)) return unavailableMetrics("missing-session-capture");

  const bySession = new Map();
  const eventSessions = new Map();
  const identities = new Map();
  for (const session of sessions) {
    if (typeof session?.sessionId !== "string" || !Array.isArray(session.events))
      throw new Error("Unsupported session capture shape.");
    if (bySession.has(session.sessionId))
      throw new Error(`Duplicate session capture: ${session.sessionId}`);
    const events = new Map();
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
      events.set(id, event);
    }
    bySession.set(session.sessionId, [...events.values()]);
  }

  const delegations = [];
  for (const [sessionId, events] of bySession)
    for (const event of events)
      if (event.type === "subagent.called" && event.data?.name === "self-modification__agent")
        delegations.push({ sessionId, event });
  if (delegations.length === 0) return unavailableMetrics("missing-delegation");

  const children = new Map();
  const parentStarts = [];
  const parentStartProblems = [];
  for (const { sessionId: parentSessionId, event: called } of delegations) {
    const { childSessionId, turnId: parentTurnId, callId } = called.data ?? {};
    if (![childSessionId, parentTurnId, callId].every((value) => typeof value === "string"))
      return unavailableMetrics("missing-delegation-identities");
    if (childSessionId === parentSessionId || !bySession.has(childSessionId))
      return unavailableMetrics(
        childSessionId === parentSessionId ? "child-session-reused" : "missing-child-capture",
      );

    const child = children.get(childSessionId) ?? { parentSessionId, calls: [] };
    if (child.parentSessionId !== parentSessionId)
      return unavailableMetrics("ambiguous-child-parent");
    child.calls.push({ callId, parentTurnId, called });
    children.set(childSessionId, child);

    const matchingParentStarts = bySession
      .get(parentSessionId)
      .filter((event) => event.type === "turn.started" && event.data?.turnId === parentTurnId);
    if (matchingParentStarts.length !== 1) {
      parentStartProblems.push(
        matchingParentStarts.length > 1
          ? "ambiguous-parent-turn-start"
          : "missing-parent-turn-start",
      );
    } else {
      parentStarts.push(matchingParentStarts[0]);
    }
  }

  const childTurns = [];
  for (const [sessionId, child] of children) {
    const events = bySession.get(sessionId);
    const invocations = events.filter((event) => event.type === "session.started");
    const invocation = invocations[0]?.data?.invocation;
    const initialCall = child.calls[0];
    if (
      invocations.length !== 1 ||
      invocation?.kind !== "subagent" ||
      invocation.parentCallId !== initialCall.callId ||
      invocation.parentSessionId !== child.parentSessionId ||
      invocation.parentTurnId !== initialCall.parentTurnId
    )
      return unavailableMetrics("child-invocation-mismatch");

    const starts = events.filter((event) => event.type === "turn.started");
    if (starts.length === 0) return unavailableMetrics("missing-child-turn");
    const completedIds = new Set();
    for (const start of starts) {
      const turnId = start.data?.turnId;
      if (typeof turnId !== "string") return unavailableMetrics("missing-child-turn-identity");
      if (completedIds.has(turnId)) return unavailableMetrics("ambiguous-child-turn");
      const completions = events.filter(
        (event) => event.type === "turn.completed" && event.data?.turnId === turnId,
      );
      if (completions.length !== 1)
        return unavailableMetrics(
          completions.length > 1 ? "ambiguous-child-turn" : "child-turn-incomplete",
        );
      completedIds.add(turnId);
      childTurns.push({ sessionId, start, completed: completions[0], events });
    }
    if (
      events.some(
        (event) => event.type === "turn.completed" && !completedIds.has(event.data?.turnId),
      )
    )
      return unavailableMetrics("child-turn-start-missing");
  }

  const allParentStarts = [...parentStarts].sort(compareEventTime);
  const allChildCompletions = childTurns.map((turn) => turn.completed).sort(compareEventTime);
  const firstParentStart = allParentStarts[0];
  const finalChildCompletion = allChildCompletions.at(-1);
  const parentStartAt = timestamp(firstParentStart);
  const childEndAt = timestamp(finalChildCompletion);
  const elapsed =
    parentStartAt !== undefined && childEndAt !== undefined
      ? childEndAt - parentStartAt
      : undefined;
  const refs = (events) =>
    events.map((event) => ({
      sessionId: eventSessions.get(event.meta.id),
      eventId: event.meta.id,
    }));
  const parentTurnToFinalChildCompletion =
    parentStartProblems.length > 0
      ? unavailable(parentStartProblems[0])
      : elapsed !== undefined && elapsed >= 0
        ? {
            status: /** @type {const} */ ("measured"),
            value: elapsed,
            evidence: refs([
              ...allParentStarts,
              ...delegations.map(({ event }) => event),
              ...allChildCompletions,
            ]),
          }
        : unavailable(
            elapsed === undefined ? "missing-parent-or-child-timestamp" : "negative-duration",
          );

  let totalDuration = 0;
  const durationEvidence = [];
  for (const { start, completed } of childTurns) {
    const startAt = timestamp(start);
    const completedAt = timestamp(completed);
    if (startAt === undefined || completedAt === undefined)
      return {
        parentTurnToFinalChildCompletion,
        totalChildDuration: unavailable("missing-child-timestamp"),
        toolCalls: unavailable("missing-child-timestamp"),
      };
    if (completedAt < startAt)
      return {
        parentTurnToFinalChildCompletion,
        totalChildDuration: unavailable("negative-duration"),
        toolCalls: unavailable("negative-duration"),
      };
    totalDuration += completedAt - startAt;
    durationEvidence.push(start, completed);
  }

  const toolIds = new Set();
  const actionEvidence = [];
  for (const { sessionId, start, events } of childTurns) {
    const turnId = start.data.turnId;
    for (const event of events) {
      if (event.type !== "actions.requested" || event.data?.turnId !== turnId) continue;
      if (!Array.isArray(event.data.actions))
        return {
          parentTurnToFinalChildCompletion,
          totalChildDuration: {
            status: /** @type {const} */ ("measured"),
            value: totalDuration,
            evidence: refs(durationEvidence),
          },
          toolCalls: unavailable("missing-tool-call-identity"),
        };
      actionEvidence.push(event);
      for (const action of event.data.actions) {
        if (action?.kind !== "tool-call") continue;
        if (typeof action.callId !== "string" || !action.callId)
          return {
            parentTurnToFinalChildCompletion,
            totalChildDuration: {
              status: /** @type {const} */ ("measured"),
              value: totalDuration,
              evidence: refs(durationEvidence),
            },
            toolCalls: unavailable("missing-tool-call-identity"),
          };
        toolIds.add(`${sessionId}\0${action.callId}`);
      }
    }
  }

  return {
    parentTurnToFinalChildCompletion,
    totalChildDuration: {
      status: /** @type {const} */ ("measured"),
      value: totalDuration,
      evidence: refs(durationEvidence),
    },
    toolCalls: {
      status: /** @type {const} */ ("measured"),
      value: toolIds.size,
      evidence: refs([...durationEvidence, ...actionEvidence]),
    },
  };
}

function timestamp(event) {
  const value = Date.parse(event?.meta?.at ?? "");
  return Number.isFinite(value) ? value : undefined;
}

function compareEventTime(left, right) {
  const leftAt = timestamp(left);
  const rightAt = timestamp(right);
  if (leftAt === undefined) return rightAt === undefined ? 0 : 1;
  return rightAt === undefined ? -1 : leftAt - rightAt;
}
