import {
  prepareCoordinationDispatch,
  type CoordinationDispatchInput,
  type CoordinationDispatchResult,
} from "#execution/coordination-dispatch-shared.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import { commitSessionStep, type SessionStepState } from "#execution/publish-session-events.js";
import {
  type SessionStateTransition,
  type WithSessionStateDelta,
} from "#execution/session/state-delta.js";
import { withSessionStateDelta } from "#execution/session/step-state-delta.js";
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
import { captureAgentSessionContext } from "#execution/agent-sessions/context.js";
import { sessionView } from "#harness/session-machine/commit.js";
import {
  startDispatchedCalls,
  startTask,
  type PendingDispatch,
  type TaskCallStart,
} from "#harness/session-machine/transitions.js";
import { storedProjection } from "#harness/session-machine/view.js";
import type { RuntimeActionResult } from "#shared/action-types.js";
import type { HarnessSessionBase } from "#harness/types.js";
import { copyView, foldLine } from "#protocol/session-projection/fold.js";
import type { SessionView } from "#protocol/session-projection/tables.js";

export async function dispatchCoordinationStep(
  input: CoordinationDispatchInput,
): Promise<WithSessionStateDelta<CoordinationDispatchResult>> {
  "use step";
  return await withSessionStateDelta(input, dispatchCoordination);
}

export async function publishDispatchedCallsStep(
  input: SessionStepState & { readonly pending: PendingDispatch },
): Promise<SessionStateTransition> {
  "use step";
  return await withSessionStateDelta(input, ({ pending, ...target }) =>
    commitSessionStep(target, (view) => [startDispatchedCalls(view, pending)], { origin: "own" }),
  );
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
      pending: { executing: [], refused: [], started: [] },
    };
  }

  const { batch, session } = prepared;
  let nextSession: HarnessSessionBase = session;
  const results: RuntimeActionResult[] = [];
  const started: TaskCallStart[] = [];
  const refused: PendingDispatch["refused"][number][] = [];
  const executing: PendingDispatch["executing"][number][] = [];
  const admissionView = copyView(storedProjection(session.state).view);

  const starts = withPrestartedRuns(
    prepared.plan.map((task) => ({
      agentContext: captureAgentSessionContext(prepared, task.callId),
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
    else if (task.entry.entryPoint === "execute")
      executing.push({ callId: task.callId, clearedBy: task.clearedBy });
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
      refused.push({ policy: dispatched.refusal, result: dispatched.result });
  }

  return {
    results,
    serializedContext: input.serializedContext,
    sessionState:
      nextSession === session
        ? prepared.sessionState
        : createDurableSessionState({ session: nextSession }),
    pending: { executing, refused, started },
  };
}

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
    run.catch(() => {});
    return { ...start, prestarted: { entry, run } };
  });
}

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
