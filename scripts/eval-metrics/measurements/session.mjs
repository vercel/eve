// What one session's v27 facts say about its model runs, calls, and turns,
// independent of capture order. Every measurement reads a session through
// this index rather than matching events itself.
import { timestamp } from "./events.mjs";

/**
 * @typedef {{
 *   runId: string,
 *   turnId: string | undefined,
 *   changeId: string | undefined,
 *   requested: object,
 *   started: object | undefined,
 *   settled: object | undefined,
 *   usage: object[],
 * }} Run `started` is the run's first `model.started`; a run without one never reached a model.
 * @typedef {{
 *   callId: string,
 *   runId: string | undefined,
 *   parentCallId: string | undefined,
 *   requested: object,
 *   taskStarted: object | undefined,
 *   settled: object | undefined,
 *   end: object | undefined,
 * }} Call `taskStarted` is the `call.started` that handed the call to a task.
 *   `end` is where the call's own work ends: the earlier of `taskStarted` and `settled`.
 */

const earliest = (a, b) =>
  a === undefined || (timestamp(b) ?? Infinity) < (timestamp(a) ?? Infinity) ? b : a;

/** @param {object[]} events one session's events */
export function indexSession(events) {
  /** @type {Map<string, Run>} */
  const runs = new Map();
  /** @type {Map<string, Call>} */
  const calls = new Map();
  const parts = new Map();
  const tasks = new Map();
  const turnStarts = new Map();
  const later = [];
  for (const event of events) {
    const data = event.data ?? {};
    if (event.type === "model.requested" && typeof data.runId === "string") {
      if (!runs.has(data.runId))
        runs.set(data.runId, {
          runId: data.runId,
          turnId: data.owner?.turnId,
          changeId: data.owner?.changeId,
          requested: event,
          started: undefined,
          settled: undefined,
          usage: [],
        });
    } else if (event.type === "call.requested" && typeof data.callId === "string") {
      const call = calls.get(data.callId);
      if (call === undefined)
        calls.set(data.callId, {
          callId: data.callId,
          runId: data.owner?.runId,
          parentCallId: data.owner?.callId,
          capability: data.capability,
          requested: event,
          taskStarted: undefined,
          settled: undefined,
          end: undefined,
        });
      else call.requested = earliest(call.requested, event);
    } else if (event.type === "turn.started" && typeof data.turnId === "string") {
      turnStarts.set(data.turnId, earliest(turnStarts.get(data.turnId), event));
    } else if (event.type === "task.started" && typeof data.taskId === "string") {
      tasks.set(data.taskId, event);
    } else if (event.type === "content.completed" && typeof data.partId === "string") {
      parts.set(data.partId, { runId: data.runId, kind: data.kind });
    } else if (
      event.type === "content.delta" &&
      typeof event.scope?.runId === "string" &&
      !parts.has(data.partId)
    ) {
      // A part's first delta names its run. An attempt that failed and was retried never
      // completes its parts, but the client saw what it streamed.
      parts.set(data.partId, { runId: event.scope.runId, kind: data.kind });
    } else {
      later.push(event);
    }
  }
  // Facts that refer to a run or call pair with it by identity, whatever order the captures merged in.
  for (const event of later) {
    const data = event.data ?? {};
    const run = runs.get(data.runId ?? data.owner?.runId);
    const call = calls.get(data.callId);
    if (event.type === "model.started" && run !== undefined)
      run.started = earliest(run.started, event);
    else if (event.type === "model.settled" && run !== undefined)
      run.settled = earliest(run.settled, event);
    else if (event.type === "usage.recorded" && run !== undefined) run.usage.push(event);
    else if (event.type === "call.started" && call !== undefined && typeof data.taskId === "string")
      call.taskStarted = earliest(call.taskStarted, event);
    else if (event.type === "call.settled" && call !== undefined)
      call.settled = earliest(call.settled, event);
  }
  for (const call of calls.values())
    call.end = [call.taskStarted, call.settled].reduce(
      (end, event) => (event === undefined ? end : earliest(end, event)),
      undefined,
    );

  const callTurn = (callId, depth = 0) => {
    const call = calls.get(callId);
    if (call === undefined || depth > calls.size) return undefined;
    if (call.runId !== undefined) return runs.get(call.runId)?.turnId;
    return call.parentCallId === undefined ? undefined : callTurn(call.parentCallId, depth + 1);
  };
  const taskTurn = (taskId) => callTurn(tasks.get(taskId)?.data?.startedBy?.callId);

  /** The turn an event belongs to, when it belongs to one. */
  const turnOf = (event) => {
    const data = event?.data ?? {};
    if (typeof data.turnId === "string") return data.turnId;
    const runId = data.runId ?? data.owner?.runId ?? parts.get(data.partId)?.runId;
    if (typeof runId === "string") return runs.get(runId)?.turnId;
    const callId = data.callId ?? data.owner?.callId ?? data.subject?.callId;
    if (typeof callId === "string") return callTurn(callId);
    const taskId = data.owner?.taskId ?? data.subject?.taskId;
    if (typeof taskId === "string") return taskTurn(taskId);
    return data.subject?.turnId;
  };

  /** The run a streamed output belongs to: a part's, or the run that requested a call. */
  const runOf = (event) => {
    const data = event?.data ?? {};
    if (event.type === "content.delta" || event.type === "content.completed")
      return parts.get(data.partId)?.runId;
    if (event.type === "call.input" || event.type === "call.requested")
      return calls.get(data.callId)?.runId;
    return undefined;
  };

  // A delivery starts the turn it caused, and any the same commit consumed into it (a batch).
  const deliveries = new Map();
  for (const [turnId, started] of turnStarts) {
    const ids = new Set();
    if (typeof started.data?.cause?.deliveryId === "string") ids.add(started.data.cause.deliveryId);
    deliveries.set(turnId, ids);
  }
  for (const event of events) {
    if (event.type !== "delivery.consumed") continue;
    const started = turnStarts.get(event.data?.turnId);
    const line = started?.meta?.position?.line;
    if (line !== undefined && event.meta?.position?.line === line)
      deliveries.get(event.data.turnId).add(event.data.deliveryId);
  }

  /** Runs that answer a turn and reached a model: the session's model steps. */
  const steps = [...runs.values()].filter(
    (run) => run.turnId !== undefined && run.started !== undefined,
  );

  /** Child sessions this session opened, with the call that opened each. */
  const children = events
    .filter((event) => event.type === "child.opened" && typeof event.data?.sessionId === "string")
    .map((event) => ({
      sessionId: event.data.sessionId,
      callId:
        event.data.owner?.callId ?? tasks.get(event.data.owner?.taskId)?.data?.startedBy?.callId,
      event,
    }));

  return { runs, calls, parts, steps, children, deliveries, turnOf, runOf };
}

/**
 * A session's failures: a model step's, a turn's, or the session's own. `type`
 * names the category as records publish it (`step.failed`, `turn.failed`,
 * `session.failed`), so failure counts trend across event vocabularies.
 *
 * @param {object[]} events
 * @param {ReturnType<typeof indexSession>} index
 * @returns {{ type: string, error: { code?: string, message?: string, details?: object } }[]}
 */
export function sessionFailures(events, index) {
  const failures = [];
  for (const run of index.steps)
    if (run.settled?.data?.outcome === "failed")
      failures.push({ type: "step.failed", error: run.settled.data.error ?? {} });
  for (const event of events) {
    if (event.type === "turn.settled" && event.data?.outcome === "failed")
      failures.push({ type: "turn.failed", error: event.data.error ?? {} });
    else if (event.type === "session.ended" && event.data?.outcome === "failed")
      failures.push({ type: "session.failed", error: event.data.error ?? {} });
  }
  return failures;
}
