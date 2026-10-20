/** Starts workflow-tool runs for pending coordination, then reports the tasks it started. */

import {
  prepareCoordinationDispatch,
  type CoordinationDispatchInput,
  type CoordinationDispatchResult,
} from "#execution/coordination-dispatch-shared.js";
import { createDurableSessionState, readDurableSession } from "#execution/durable-session-store.js";
import { publishSessionEvents, type SessionStepState } from "#execution/publish-session-events.js";
import {
  withSessionStateDelta,
  type SessionStateTransition,
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
import type { TaskStartedStreamEvent } from "#protocol/message.js";
import { sessionView } from "#harness/session-machine/commit.js";
import { startTask } from "#harness/session-machine/transitions.js";
import { storedProjection } from "#harness/session-machine/view.js";
import type { RuntimeActionResult } from "#shared/action-types.js";
import type { HarnessSessionBase } from "#harness/types.js";

type CoordinationDispatchStepInput = CoordinationDispatchInput & {
  readonly action: "park";
};

/**
 * Starts the runs of the pending calls and records them on the session. It
 * publishes nothing: a retry of this step starts runs again unless the
 * session already records them, so the step commits before anything slow,
 * such as a `task.started` hook, can run. See {@link publishTaskStartedStep}.
 */
export async function dispatchCoordinationStep(
  input: CoordinationDispatchStepInput,
): Promise<WithSessionStateDelta<CoordinationDispatchResult>> {
  "use step";
  return await withSessionStateDelta(input, dispatchCoordination);
}

/**
 * Publishes `task.started` for the tasks {@link dispatchCoordinationStep}
 * started, before their receipts reach the turn. A retry only publishes again.
 */
export async function publishTaskStartedStep(
  input: SessionStepState & { readonly started: readonly TaskStartedStreamEvent["data"][] },
): Promise<SessionStateTransition> {
  "use step";
  return await withSessionStateDelta(input, async ({ started, ...target }) => {
    const { state } = readDurableSession(target.sessionState);
    const view = sessionView(storedProjection(state), state);
    return await publishSessionEvents(
      target,
      started.flatMap((task) => startTask(view, task).events),
    );
  });
}

async function dispatchCoordination(
  input: CoordinationDispatchStepInput,
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
      started: [],
    };
  }

  const { batch, session } = prepared;
  let nextSession = session;
  const results: RuntimeActionResult[] = [];
  const started: TaskStartedStreamEvent["data"][] = [];
  const agentLimits = resolveStepAgentLimits(prepared);

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
  );

  for (const start of starts) {
    const dispatched = await dispatchWorkflowCall({ ...start, session: nextSession });
    nextSession = dispatched.session;
    if (dispatched.result !== undefined) results.push(dispatched.result);
    if (dispatched.started !== undefined) started.push(dispatched.started);
  }

  return {
    results,
    serializedContext: input.serializedContext,
    sessionState:
      nextSession === session
        ? prepared.sessionState
        : createDurableSessionState({ session: nextSession }),
    started,
  };
}

/**
 * Starts the runs of a batch at once, in place of one after another, when
 * dispatching it in order is sure to record every one of them. Otherwise
 * each dispatch starts its own run, as the task cap and earlier calls allow.
 */
function withPrestartedRuns(
  starts: readonly StartWorkflowTaskInput[],
  table: TaskTable,
): readonly StartWorkflowTaskInput[] {
  const tasks = starts.map((start) => start.task);
  const entries = tasks.map((task) => runEntryToStart(table, task));
  const together =
    entries.filter((entry) => entry !== undefined).length > 1 && startsEveryRun(table, tasks);
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
async function dispatchWorkflowCall(start: StartWorkflowTaskInput): Promise<{
  readonly result?: RuntimeActionResult;
  readonly session: HarnessSessionBase;
  readonly started?: TaskStartedStreamEvent["data"];
}> {
  const { entry } = start.task;
  switch (entry.entryPoint) {
    case "execute":
      return await startWorkflowTask(start);
    case "task":
    case "serve":
      return await startTaskRun({ ...start, entry });
    case "receive":
      return await sendToTask({ ...start, taskId: entry.taskId });
  }
}
