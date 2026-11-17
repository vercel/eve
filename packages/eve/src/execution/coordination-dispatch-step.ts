import {
  prepareCoordinationDispatch,
  type CoordinationDispatchInput,
  type CoordinationDispatchResult,
} from "#execution/coordination-dispatch-shared.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import { commitSessionStep, type SessionStepInput } from "#execution/publish-session-events.js";
import {
  type SessionStateTransition,
  type WithSessionStateDelta,
} from "#execution/session/state-delta.js";
import { withSessionStateDelta } from "#execution/session/step-state-delta.js";
import {
  startWorkflowTask,
  startWorkflowToolCallRun,
  type StartWorkflowTaskInput,
  type StartWorkflowToolRun,
} from "#execution/tools/workflow/start.js";
import {
  runEntryToStart,
  sendToTask,
  startsEveryRun,
  startTaskRun,
} from "#execution/tasks/start.js";
import {
  readTaskTable,
  removeTask,
  writeTaskTable,
  type TaskTable,
} from "#execution/tasks/table.js";
import { createRuntimeToolResultFromValue } from "#harness/action-result-helpers.js";
import { hasWorkflowAdmission } from "#harness/workflow-admission.js";
import { captureAgentSessionContext } from "#execution/agent-sessions/context.js";
import { sessionView } from "#harness/session-machine/commit.js";
import {
  startDispatchedCalls,
  startTask,
  type PendingDispatch,
  type TaskCallStart,
} from "#harness/session-machine/transitions.js";
import { storedProjection } from "#harness/session-machine/view.js";
import type { RuntimeActionResult, RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import type { HarnessSessionBase } from "#harness/types.js";
import { copyView, foldLine } from "#protocol/session-projection/fold.js";
import type { SessionView } from "#protocol/session-projection/tables.js";

export function dispatchCoordinationOn(
  startRun: StartWorkflowToolRun,
): (
  input: CoordinationDispatchInput,
) => Promise<WithSessionStateDelta<CoordinationDispatchResult>> {
  return async (input) =>
    await withSessionStateDelta(input, (state) => dispatchCoordination(state, startRun));
}

export async function publishDispatchedCallsStep(
  input: SessionStepInput & { readonly pending: PendingDispatch },
): Promise<SessionStateTransition> {
  "use step";
  return await withSessionStateDelta(input, ({ pending, ...target }) =>
    commitSessionStep(target, (view) => [startDispatchedCalls(view, pending)], { origin: "own" }),
  );
}

async function dispatchCoordination(
  input: CoordinationDispatchInput,
  startRun: StartWorkflowToolRun,
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
  const admitted: RuntimeWorkflowTaskRequest[] = [];
  for (const task of prepared.plan) {
    if (hasWorkflowAdmission(task)) {
      admitted.push(task);
      continue;
    }
    const result = createRuntimeToolResultFromValue({
      callId: task.callId,
      toolName: task.toolName,
      output: {
        code: "TOOL_EXECUTION_DENIED",
        message:
          "The call was not started: it was not admitted to run, for example because it was " +
          "made before an upgrade. Make the call again to run it.",
        tool: { result: "not_run" },
      },
      isError: true,
    });
    results.push(result);
    refused.push({ policy: "admission", result });
    if (task.entry.entryPoint === "task" || task.entry.entryPoint === "serve") {
      nextSession = writeTaskTable(
        nextSession,
        removeTask(readTaskTable(nextSession.state), task.entry.taskId),
      );
    }
  }

  const starts = withPrestartedRuns(
    admitted.map((task) => ({
      agentContext: captureAgentSessionContext(prepared, task.callId),
      auth: {
        current: prepared.auth,
        initiator: prepared.initiatorAuth,
      },
      batchEvent: batch.event,
      owner: input.workflowToolRunOwner,
      parentSession: prepared.parentSession,
      session: nextSession,
      startRun,
      task,
    })),
    readTaskTable(nextSession.state),
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
