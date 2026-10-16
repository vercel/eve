/** Starts workflow-tool runs for pending coordination. */

import {
  prepareCoordinationDispatch,
  type CoordinationDispatchInput,
  type CoordinationDispatchResult,
} from "#execution/coordination-dispatch-shared.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import { publishSessionEvents } from "#execution/publish-session-events.js";
import {
  withSessionStateDelta,
  type WithSessionStateDelta,
} from "#execution/session/state-delta.js";
import {
  startWorkflowTask,
  startWorkflowToolCallRun,
  type StartWorkflowTaskInput,
} from "#execution/tools/workflow/start.js";
import {
  runEntryToStart,
  sendToTask,
  startsEveryRun,
  startTaskRun,
} from "#execution/tasks/start.js";
import { readTaskTable, type TaskTable } from "#execution/tasks/table.js";
import {
  captureAgentSessionContext,
  resolveStepAgentLimits,
} from "#execution/agent-sessions/context.js";
import { sessionView } from "#harness/session-machine/commit.js";
import { startTask, type TaskCallStart } from "#harness/session-machine/transitions.js";
import { storedProjection } from "#harness/session-machine/view.js";
import type { RuntimeActionResult } from "#shared/action-types.js";
import type { HarnessSessionBase } from "#harness/types.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { callSettledFrom, callStarted } from "#harness/call-facts.js";
import { copyView, foldLine } from "#protocol/session-projection/fold.js";
import type { SessionView } from "#protocol/session-projection/tables.js";

export async function dispatchCoordinationStep(
  input: CoordinationDispatchInput,
): Promise<WithSessionStateDelta<CoordinationDispatchResult>> {
  "use step";
  return await withSessionStateDelta(input, dispatchCoordination);
}

async function dispatchCoordination(
  input: CoordinationDispatchInput,
): Promise<CoordinationDispatchResult> {
  const prepared = await prepareCoordinationDispatch({
    serializedContext: input.serializedContext,
    sessionState: input.sessionState,
  });
  if (prepared === undefined) {
    return {
      results: [],
      serializedContext: input.serializedContext,
      sessionState: input.sessionState,
    };
  }

  const { batch, session } = prepared;
  let nextSession = session;
  const results: RuntimeActionResult[] = [];
  const started: TaskCallStart[] = [];
  const refused: SessionEvent[] = [];
  const executing: SessionEvent[] = [];
  const agentLimits = resolveStepAgentLimits(prepared);
  // Prospective facts for this admission batch use the same fold as committed facts. This
  // shadow is never saved: limits count work actually started earlier in the batch without
  // introducing a private lifecycle counter or treating undispatched intents as queued work.
  const admissionView = copyView(storedProjection(session.state).view);

  const starts = withPrestartedRuns(
    prepared.plan.map((task) => ({
      agentContext: captureAgentSessionContext(prepared, task.callId, agentLimits),
      auth: {
        current: prepared.auth,
        initiator: prepared.initiatorAuth,
      },
      batchEvent: batch.event,
      owner: input.workflowToolRunOwner,
      parentSession: prepared.parentSession,
      session,
      task,
    })),
    readTaskTable(session.state),
    admissionView,
  );

  for (const start of starts) {
    const { task } = start;
    const dispatched = await dispatchWorkflowCall(
      { ...start, session: nextSession },
      admissionView,
    );
    nextSession = dispatched.session;
    if (dispatched.result !== undefined) results.push(dispatched.result);
    // A call the turn waits on runs from now, in its own run; a task's call starts with its task.
    else if (task.entry.entryPoint === "execute")
      executing.push(callStarted(task.callId, { clearedBy: task.clearedBy }));
    if (dispatched.started !== undefined) {
      started.push(dispatched.started);
      const shadow = sessionView(
        { ...storedProjection(nextSession.state), view: admissionView },
        nextSession.state,
      );
      foldLine(
        admissionView,
        { at: new Date().toISOString(), facts: startTask(shadow, dispatched.started).events },
        admissionView.position,
      );
    }
    if (dispatched.refusal !== undefined && dispatched.result !== undefined)
      refused.push(
        callSettledFrom(dispatched.result, {
          rejected: true,
          cause: { policy: dispatched.refusal },
        }),
      );
  }

  const view = sessionView(storedProjection(nextSession.state), nextSession.state);
  // One introduction per task in this commit, based on the public table and this batch's
  // pending facts, not the private runtime address (which can exist before publication).
  const introducedTasks = new Set(Object.keys(view.projection.view.tasks));
  const published = await publishSessionEvents(
    {
      serializedContext: input.serializedContext,
      sessionState:
        nextSession === session
          ? prepared.sessionState
          : createDurableSessionState({ session: nextSession }),
      sessionWritable: input.sessionWritable,
    },
    [
      ...executing,
      ...started.flatMap((task) => startTask(view, task, introducedTasks).events),
      ...refused,
    ],
  );
  return { results, ...published };
}

/**
 * Starts the runs of a batch at once, in place of one after another, when
 * dispatching it in order is sure to record every one of them. Otherwise
 * each dispatch starts its own run, as the task cap and earlier calls allow.
 */
function withPrestartedRuns(
  starts: readonly StartWorkflowTaskInput[],
  table: TaskTable,
  view: SessionView,
): readonly StartWorkflowTaskInput[] {
  const tasks = starts.map((start) => start.task);
  const entries = tasks.map((task) => runEntryToStart(table, view, task));
  const together =
    entries.filter((entry) => entry !== undefined).length > 1 && startsEveryRun(table, view, tasks);
  if (!together) return starts;
  return starts.map((start, index) => {
    const entry = entries[index];
    if (entry === undefined) return start;
    const run = startWorkflowToolCallRun(start, entry);
    // Each dispatch awaits its own run in order, so a later failure waits unhandled until then.
    run.catch(() => {});
    return { ...start, prestarted: { entry, run } };
  });
}

/**
 * Starts the run the call's entry point names, or sends a call with `taskId`
 * to the running `serve` task it names.
 */
async function dispatchWorkflowCall(
  start: StartWorkflowTaskInput,
  admissionView: SessionView,
): Promise<{
  readonly result?: RuntimeActionResult;
  readonly session: HarnessSessionBase;
  readonly started?: TaskCallStart;
  readonly refusal?: "task-limit" | "task-unavailable";
}> {
  const { entry } = start.task;
  switch (entry.entryPoint) {
    case "execute":
      return await startWorkflowTask(start);
    case "task":
    case "serve":
      return await startTaskRun({ ...start, entry }, admissionView);
    case "receive":
      return await sendToTask({ ...start, taskId: entry.taskId }, admissionView);
  }
}
