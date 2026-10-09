// Closing what an ending owner leaves open. Every terminal path — a turn settling, a session
// ending, a discarded model attempt, a failed context change — asks the shared fold what is still
// open under the owner (`openWork`) and settles it here, in the commit of the owner's own terminal
// fact, so nothing stays open and nothing settles twice.

import type { SessionEvent } from "#protocol/session-event.js";
import type { ErrorInfo, Scope } from "#protocol/session-events/envelope.js";
import type { CallOutcome } from "#protocol/session-events/families/call.js";
import type { ContextOutcome } from "#protocol/session-events/families/context.js";
import type { DeliveryOutcome } from "#protocol/session-events/families/delivery.js";
import type { InteractionOutcome } from "#protocol/session-events/families/interaction.js";
import type { ResponseOutcome } from "#protocol/session-events/families/response.js";
import type { ModelOutcome } from "#protocol/session-events/families/model.js";
import type { TurnOutcome } from "#protocol/session-events/families/turn.js";
import type { TaskOutcome } from "#protocol/session-events/families/task.js";
import { emptySessionView } from "#protocol/session-projection/fold.js";
import {
  callTask,
  callTurn,
  interactionOwner,
  type OpenWork,
  runTurn,
} from "#protocol/session-projection/selectors.js";
import type { SessionView as PublicView } from "#protocol/session-projection/tables.js";

/** How the work an owner leaves open settles, kind by kind. */
export interface Closure {
  readonly calls: CallOutcome;
  readonly runs: ModelOutcome;
  readonly changes: ContextOutcome;
  readonly deliveries: DeliveryOutcome;
  readonly tasks: TaskOutcome;
  readonly interactions: InteractionOutcome;
  readonly responses: ResponseOutcome;
  /** Why the open calls and deliveries stopped. */
  readonly reason: string;
  /** Recorded on the runs and changes that fail. */
  readonly error?: ErrorInfo;
}

/** How each way an owner ends settles what it leaves open. */
export function closureFor(
  ending:
    | { readonly turn: TurnOutcome; readonly error?: ErrorInfo }
    | { readonly session: "completed" | "failed"; readonly error?: ErrorInfo }
    | { readonly attempt: "retried" | "steered" }
    | { readonly change: "failed"; readonly error: ErrorInfo }
    | { readonly task: TaskOutcome; readonly error?: ErrorInfo; readonly reason?: string },
): Closure {
  if ("turn" in ending) {
    const failed = ending.turn === "failed";
    return {
      calls: "interrupted",
      changes: failed ? "failed" : "interrupted",
      deliveries: "handled",
      error: failed ? ending.error : undefined,
      reason: `turn-${ending.turn === "completed" ? "ended" : ending.turn}`,
      runs: failed ? "failed" : "interrupted",
      tasks: "cancelled",
      interactions: "interrupted",
      responses: "withdrawn",
    };
  }
  if ("session" in ending) {
    const failed = ending.session === "failed";
    return {
      calls: "interrupted",
      changes: failed ? "failed" : "interrupted",
      deliveries: "failed",
      error: failed ? ending.error : undefined,
      reason: "session-ended",
      runs: failed ? "failed" : "interrupted",
      tasks: "cancelled",
      interactions: "interrupted",
      responses: "withdrawn",
    };
  }
  if ("attempt" in ending) {
    const retried = ending.attempt === "retried";
    return {
      calls: retried ? "abandoned" : "interrupted",
      changes: "interrupted",
      deliveries: "handled",
      reason: retried ? "model-call-retried" : "steered",
      runs: retried ? "abandoned" : "interrupted",
      tasks: "cancelled",
      interactions: retried ? "abandoned" : "interrupted",
      responses: retried ? "abandoned" : "withdrawn",
    };
  }
  if ("task" in ending)
    return {
      calls: ending.task === "failed" ? "failed" : "interrupted",
      changes: "interrupted",
      deliveries: "handled",
      error: ending.error,
      reason: ending.reason ?? "task-ended",
      runs: "interrupted",
      tasks: ending.task,
      interactions: "interrupted",
      responses: "withdrawn",
    };
  return {
    calls: "interrupted",
    changes: "failed",
    deliveries: "handled",
    error: ending.error,
    reason: "context-change-failed",
    runs: "failed",
    tasks: "cancelled",
    interactions: "interrupted",
    responses: "withdrawn",
  };
}

/** The shared tables a private projection keeps, or empty ones before the first commit. */
export function publicViewOf(projection: { readonly view?: PublicView } | undefined): PublicView {
  return projection?.view ?? emptySessionView();
}

/**
 * The facts that settle `open`, in the order a reader needs them: calls before the runs that
 * made them, the runs and context changes, then the deliveries. The owner's own terminal fact goes
 * between `work` and `deliveries`: a turn settles before the deliveries it answered.
 */
export function closeFacts(
  view: PublicView,
  open: OpenWork,
  closure: Closure,
): { readonly work: SessionEvent[]; readonly deliveries: SessionEvent[] } {
  const work: SessionEvent[] = [];
  // What answers an interaction settles before it; a responder's sign-in before its response.
  const aboutResponse = open.interactions.filter((row) => "responseId" in row.subject);
  const interactionFact = (row: (typeof open.interactions)[number]): SessionEvent => {
    const owner = interactionOwner(view, row);
    const scope: { -readonly [K in keyof Scope]: Scope[K] } = {};
    if (owner.turnId !== undefined) scope.turnId = owner.turnId;
    if (owner.taskId !== undefined) scope.taskId = owner.taskId;
    return {
      data: {
        interactionId: row.interactionId,
        outcome: closure.interactions,
        reason: closure.reason,
      },
      scope,
      type: "interaction.settled",
    };
  };
  work.push(...aboutResponse.map(interactionFact));
  for (const response of open.responses) {
    work.push({
      data: { outcome: closure.responses, reason: closure.reason, responseId: response.responseId },
      type: "response.settled",
    });
  }
  work.push(
    ...open.interactions.filter((row) => !("responseId" in row.subject)).map(interactionFact),
  );
  // Descendants first, including calls introduced in the same commit as their parents.
  const depth = (callId: string): number => {
    const seen = new Set<string>();
    let call = view.calls[callId];
    while (call !== undefined && !seen.has(call.callId)) {
      seen.add(call.callId);
      if (!("callId" in call.owner)) break;
      call = view.calls[call.owner.callId];
    }
    return seen.size;
  };
  const calls = [...open.calls].sort(
    (a, b) => depth(b.callId) - depth(a.callId) || b.introducedAt - a.introducedAt,
  );
  for (const call of calls) {
    const scope: { -readonly [K in keyof Scope]: Scope[K] } = {};
    const turnId = callTurn(view, call);
    if (turnId !== undefined) scope.turnId = turnId;
    const taskId = callTask(view, call);
    if (taskId !== undefined) scope.taskId = taskId;
    const data: { callId: string; outcome: CallOutcome; reason: string; error?: ErrorInfo } = {
      callId: call.callId,
      outcome: closure.calls,
      reason: closure.reason,
    };
    if (closure.calls === "failed" && closure.error !== undefined) data.error = closure.error;
    work.push({
      data,
      scope,
      type: "call.settled",
    });
  }
  for (const run of open.runs) {
    const scope: { -readonly [K in keyof Scope]: Scope[K] } = { runId: run.runId };
    const turnId = runTurn(view, run);
    if (turnId !== undefined) scope.turnId = turnId;
    if ("changeId" in run.owner) scope.changeId = run.owner.changeId;
    const data: { runId: string; outcome: ModelOutcome; error?: ErrorInfo } = {
      outcome: closure.runs,
      runId: run.runId,
    };
    if (closure.runs === "failed" && closure.error !== undefined) data.error = closure.error;
    work.push({ data, scope, type: "model.settled" });
  }
  for (const task of open.tasks) {
    const data: { taskId: string; outcome: TaskOutcome; reason: string; error?: ErrorInfo } = {
      taskId: task.taskId,
      outcome: closure.tasks,
      reason: closure.reason,
    };
    if (closure.tasks === "failed" && closure.error !== undefined) data.error = closure.error;
    work.push({ type: "task.ended", data, scope: { taskId: task.taskId } });
  }
  for (const change of open.changes) {
    const scope: { -readonly [K in keyof Scope]: Scope[K] } = { changeId: change.changeId };
    if (change.turnId !== undefined) scope.turnId = change.turnId;
    const data: {
      changeId: string;
      kind: typeof change.kind;
      outcome: ContextOutcome;
      error?: ErrorInfo;
    } = { changeId: change.changeId, kind: change.kind, outcome: closure.changes };
    if (closure.changes === "failed" && closure.error !== undefined) data.error = closure.error;
    work.push({ data, scope, type: "context.settled" });
  }
  const deliveries: SessionEvent[] = open.deliveries.map((delivery) => {
    const data: { deliveryId: string; outcome: DeliveryOutcome; turnId?: string; reason?: string } =
      { deliveryId: delivery.deliveryId, outcome: closure.deliveries };
    if (closure.deliveries === "handled" && delivery.turnId !== undefined) {
      data.turnId = delivery.turnId;
    } else {
      data.reason = closure.reason;
    }
    return { data, type: "delivery.settled" };
  });
  return { deliveries, work };
}

/** Every open entity in `open` that `closed` doesn't already settle. */
export function notIn(open: OpenWork, closed: OpenWork): OpenWork {
  const callIds = new Set(closed.calls.map((row) => row.callId));
  const runIds = new Set(closed.runs.map((row) => row.runId));
  const changeIds = new Set(closed.changes.map((row) => row.changeId));
  const deliveryIds = new Set(closed.deliveries.map((row) => row.deliveryId));
  const taskIds = new Set(closed.tasks.map((row) => row.taskId));
  const interactionIds = new Set(closed.interactions.map((row) => row.interactionId));
  const responseIds = new Set(closed.responses.map((row) => row.responseId));
  return {
    interactions: open.interactions.filter((row) => !interactionIds.has(row.interactionId)),
    responses: open.responses.filter((row) => !responseIds.has(row.responseId)),
    calls: open.calls.filter((row) => !callIds.has(row.callId)),
    changes: open.changes.filter((row) => !changeIds.has(row.changeId)),
    deliveries: open.deliveries.filter((row) => !deliveryIds.has(row.deliveryId)),
    runs: open.runs.filter((row) => !runIds.has(row.runId)),
    tasks: open.tasks.filter((row) => !taskIds.has(row.taskId)),
  };
}
