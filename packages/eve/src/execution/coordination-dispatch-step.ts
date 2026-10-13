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
import type { TaskStartedStreamEvent } from "#protocol/message.js";
import { sessionView } from "#harness/session-machine/commit.js";
import { startTask } from "#harness/session-machine/transitions.js";
import { storedProjection } from "#harness/session-machine/view.js";
import type { RuntimeActionResult } from "#shared/action-types.js";
import type { HarnessSessionBase } from "#harness/types.js";

type CoordinationDispatchStepInput = CoordinationDispatchInput & {
  readonly action: "park";
};

export async function dispatchCoordinationStep(
  input: CoordinationDispatchStepInput,
): Promise<WithSessionStateDelta<CoordinationDispatchResult>> {
  "use step";
  return await withSessionStateDelta(input, dispatchCoordination);
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

  const published = await publishSessionEvents(
    {
      serializedContext: input.serializedContext,
      sessionState:
        nextSession === session
          ? prepared.sessionState
          : createDurableSessionState({ session: nextSession }),
      sessionWritable: input.sessionWritable,
    },
    started.flatMap(
      (task) =>
        startTask(sessionView(storedProjection(nextSession.state), nextSession.state), task).events,
    ),
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
