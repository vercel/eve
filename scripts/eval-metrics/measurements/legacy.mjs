// One-way upgrade of a pre-v27 session capture (eve before 0.84.0) into the
// v27 facts the measurements read, so release backfills of older eve keep
// their metrics. Nothing else may read the old vocabulary: when backfills no
// longer reach eve before 0.84.0, delete this file and its call in events.mjs.
//
// Upgraded events keep their source's `meta`, so `meta.id` still identifies
// them and `meta.at` is still when they were written (pre-v27 deltas carried
// their own times). Each gets a synthetic position whose line is its source
// event, so facts upgraded from one event share a commit, as in v27.
//
// Old                          v27
//   step.started                 model.requested + model.started (run `<turnId>/<stepIndex>`)
//   step.completed / .failed     model.settled (+ usage.recorded)
//   message|reasoning.appended   content.delta
//   message|reasoning.completed  content.completed (synthesized for parts that never completed)
//   action.input.appended        call.input
//   actions.requested            call.requested, one per action (an agent task's call is `agent`)
//   action.result                call.settled, except a task's start acknowledgement
//   task.started / task.settled  call.started {taskId} / call.settled
//   agent.started                child.opened
//   turn.completed|failed|cancelled  turn.settled
//   session.failed               session.ended
//   input.*, approval.*, authorization.*  interaction.opened / interaction.settled
//   compaction.*, context.cleared         context.started / context.settled

const CAPABILITY = {
  "tool-call": "tool",
  "workflow-tool-call": "tool",
  "subagent-call": "agent",
  "remote-agent-call": "agent",
  "load-skill": "skill",
};
const TURN_OUTCOME = {
  "turn.completed": "completed",
  "turn.failed": "failed",
  "turn.cancelled": "cancelled",
};
const TASK_OUTCOME = { completed: "completed", failed: "failed", cancelled: "interrupted" };

// eve before 0.69.0 delegated through these events instead of `agent.started`
// and `task.*`: its child sessions read as root sessions and its delegated
// work as nothing, so no metric of such an attempt means what it does today.
const PRE_TASK_DELEGATION = new Set([
  "subagent.called",
  "subagent.started",
  "subagent.completed",
  "subagent.event",
  "execution.background_task",
]);

/** Whether a capture predates tasks (eve before 0.69.0), which this upgrade can't express. */
export function predatesTasks(events) {
  return Array.isArray(events) && events.some((event) => PRE_TASK_DELEGATION.has(event?.type));
}

/** Whether a capture predates v27: its events carry `meta.id`, never a position. */
export function isLegacyCapture(events) {
  return events.some(
    (event) => typeof event?.meta?.id === "string" && event.meta.position === undefined,
  );
}

/** @param {object[]} events one session's pre-v27 events, deduplicated, in capture order */
export function upgradeLegacyEvents(events) {
  // A task's call is acknowledged with an `action.result` once the task starts;
  // in v27 the call settles only with the task's result.
  const taskStarts = events.filter((e) => e.type === "task.started");
  const taskCalls = new Set(taskStarts.map((e) => e.data?.callId));
  // An agent call was an ordinary tool call that started an agent task; v27
  // names it an `agent` capability, which tool counts leave out.
  const agentCalls = new Set(
    taskStarts.filter((e) => e.data?.kind !== "tool").map((e) => e.data?.callId),
  );
  const requestedCalls = new Set(
    events
      .filter((e) => e.type === "actions.requested")
      .flatMap((e) => (Array.isArray(e.data?.actions) ? e.data.actions : []))
      .map((action) => action?.callId),
  );
  const approvalCandidates = new Set(
    events
      .filter((e) => e.type === "approval.candidate" && e.data?.outcome === "pending")
      .map((e) => e.data?.requestId),
  );
  const out = [];
  const completedParts = new Set();
  const openParts = new Map();
  events.forEach((event, line) => {
    let index = 0;
    const emit = (type, data) =>
      out.push({ type, data, meta: { ...event.meta, position: { line, index: index++ } } });
    const d = event.data ?? {};
    const runId = `${d.turnId}/${d.stepIndex}`;
    const part = (kind) => `${runId}:${kind}`;
    const error = { code: d.code ?? "UNKNOWN", message: d.message ?? "", details: d.details };
    switch (event.type) {
      case "session.started":
        return emit("session.started", {
          ...d,
          ...(d.invocation?.kind === "subagent" && { parent: d.invocation }),
        });
      case "turn.started": {
        const deliveryIds = event.meta?.deliveryIds ?? [];
        emit("turn.started", {
          turnId: d.turnId,
          trace: d.trace,
          ...(deliveryIds[0] !== undefined && { cause: { deliveryId: deliveryIds[0] } }),
        });
        for (const deliveryId of deliveryIds)
          emit("delivery.consumed", { deliveryId, turnId: d.turnId, parts: [] });
        return;
      }
      case "turn.completed":
      case "turn.failed":
      case "turn.cancelled":
        return emit("turn.settled", {
          turnId: d.turnId,
          outcome: TURN_OUTCOME[event.type],
          ...(event.type === "turn.failed" && { error }),
        });
      case "session.failed":
        return emit("session.ended", { outcome: "failed", error });
      case "step.started":
        emit("model.requested", { runId, owner: { turnId: d.turnId } });
        return emit("model.started", { runId, modelId: d.modelId, attempt: 0 });
      case "step.completed":
        emit("model.settled", { runId, outcome: "completed", finishReason: d.finishReason });
        if (d.usage !== undefined)
          emit("usage.recorded", { owner: { runId }, kind: "model", usage: d.usage });
        return;
      case "step.failed":
        return emit("model.settled", { runId, outcome: "failed", error });
      case "message.appended":
      case "reasoning.appended": {
        const kind = event.type === "message.appended" ? "text" : "reasoning";
        openParts.set(part(kind), { runId, kind, event });
        return emit("content.delta", {
          partId: part(kind),
          kind,
          delta: d.messageDelta ?? d.reasoningDelta ?? "",
        });
      }
      case "message.completed":
      case "reasoning.completed": {
        const kind = event.type === "message.completed" ? "text" : "reasoning";
        completedParts.add(part(kind));
        return emit("content.completed", { partId: part(kind), runId, kind, phase: "reply" });
      }
      case "action.input.appended":
        if (requestedCalls.has(d.callId))
          return emit("call.input", { callId: d.callId, delta: d.inputTextDelta ?? "" });
        // Old eve could stream a call's input and never request the call (v27
        // requests it with `inputError`); such input was streamed output of its
        // step, measured as a first token but never shown, like reasoning.
        openParts.set(part("input"), { runId, kind: "reasoning", event });
        return emit("content.delta", {
          partId: part("input"),
          kind: "reasoning",
          delta: d.inputTextDelta ?? "",
        });
      case "actions.requested":
        for (const action of Array.isArray(d.actions) ? d.actions : [])
          emit("call.requested", {
            callId: action?.callId,
            owner: { runId },
            capability: {
              kind: agentCalls.has(action?.callId)
                ? "agent"
                : (CAPABILITY[action?.kind] ?? action?.kind),
              name: action?.toolName,
            },
          });
        return;
      case "action.result":
        if (taskCalls.has(d.result?.callId)) return;
        return emit("call.settled", {
          callId: d.result?.callId,
          outcome: d.status === "failed" ? "failed" : "completed",
        });
      case "task.started":
        return emit("call.started", { callId: d.callId, taskId: d.taskId });
      case "task.settled":
        return emit("call.settled", {
          callId: d.callId,
          outcome: TASK_OUTCOME[d.status] ?? "completed",
        });
      case "agent.started":
        return emit("child.opened", {
          sessionId: d.sessionId,
          owner: { callId: d.callId },
          name: d.name,
        });
      case "input.requested":
        for (const request of Array.isArray(d.requests) ? d.requests : [])
          emit("interaction.opened", {
            interactionId: `input:${request?.requestId}`,
            subject: { turnId: d.turnId },
          });
        return;
      case "input.resolved":
        for (const resolution of Array.isArray(d.resolutions) ? d.resolutions : [])
          emit("interaction.settled", {
            interactionId: `input:${resolution?.requestId}`,
            outcome: resolution?.outcome === "invalid" ? "invalid" : "accepted",
          });
        return;
      case "approval.candidate":
        if (d.outcome !== "pending") return;
        return emit("interaction.opened", {
          interactionId: `approval:${d.requestId}`,
          subject: { turnId: d.turnId },
        });
      case "approval.settled":
        // Only responder-bound candidates waited on a person; the rest settled an input request.
        if (!approvalCandidates.has(d.requestId)) return;
        return emit("interaction.settled", {
          interactionId: `approval:${d.requestId}`,
          outcome: "accepted",
        });
      case "authorization.required":
      case "authorization.completed": {
        const interactionId = `authorization:${d.turnId}/${d.name}`;
        return event.type === "authorization.required"
          ? emit("interaction.opened", { interactionId, subject: { turnId: d.turnId } })
          : emit("interaction.settled", { interactionId, outcome: "accepted" });
      }
      case "compaction.requested":
        return emit("context.started", { changeId: runId, kind: "compaction", turnId: d.turnId });
      case "compaction.completed":
        return emit("context.settled", {
          changeId: runId,
          kind: "compaction",
          outcome: "completed",
        });
      case "context.cleared":
        return emit("context.settled", {
          changeId: event.meta?.id,
          kind: "clear",
          outcome: "completed",
        });
    }
  });
  // v27 completes every part it streams, interrupted or not, which is how a part names its run.
  let index = 0;
  for (const [partId, { runId, kind, event }] of openParts) {
    if (completedParts.has(partId)) continue;
    out.push({
      type: "content.completed",
      data: { partId, runId, kind, phase: "reply" },
      meta: { ...event.meta, position: { line: events.length, index: index++ } },
    });
  }
  return out;
}
