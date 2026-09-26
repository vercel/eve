/** Starts workflow-tool runs for pending coordination. */

import {
  prepareCoordinationDispatch,
  type CoordinationDispatchInput,
  type CoordinationDispatchResult,
} from "#execution/coordination-dispatch-shared.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import { publishSessionEvents } from "#execution/publish-session-events.js";
import { startWorkflowTask, type StartWorkflowTaskInput } from "#execution/tools/workflow/start.js";
import { sendToTask, startTaskRun } from "#execution/tasks/start.js";
import { captureAgentSessionContext } from "#execution/agent-sessions/context.js";
import type { TaskStartedStreamEvent } from "#protocol/message.js";
import type { RuntimeActionResult } from "#shared/action-types.js";
import type { HarnessSession } from "#harness/types.js";

type CoordinationDispatchStepInput = CoordinationDispatchInput & {
  readonly action: "park";
};

export async function dispatchCoordinationStep(
  input: CoordinationDispatchStepInput,
): Promise<CoordinationDispatchResult> {
  "use step";

  const prepared = await prepareCoordinationDispatch({
    serializedContext: input.serializedContext,
    sessionState: input.sessionState,
  });
  if (prepared === undefined) {
    return {
      results: [],
      sessionState: input.sessionState,
    };
  }

  const { batch, session } = prepared;
  let nextSession = session;
  const results: RuntimeActionResult[] = [];
  const started: TaskStartedStreamEvent[] = [];

  for (const task of prepared.plan) {
    const start = {
      agentContext: captureAgentSessionContext(prepared, task.callId),
      agents: prepared.workflowAgents,
      auth: prepared.auth,
      batchEvent: batch.event,
      initiatorAuth: prepared.initiatorAuth,
      owner: input.workflowToolRunOwner,
      parentSession: prepared.parentSession,
      session: nextSession,
      task,
    };
    const dispatched = await dispatchWorkflowCall(start);
    nextSession = dispatched.session;
    if (dispatched.result !== undefined) results.push(dispatched.result);
    if (dispatched.started !== undefined) started.push(dispatched.started);
  }

  const sessionState =
    nextSession === session
      ? prepared.sessionState
      : createDurableSessionState({ session: nextSession });
  const published = await publishSessionEvents(
    {
      serializedContext: prepared.serializedContext,
      sessionState,
      sessionWritable: input.sessionWritable,
    },
    started,
  );
  return { results, ...published };
}

/**
 * Starts the run the call's entry point names, or sends a call with `taskId`
 * to the running `serve` task it names.
 */
async function dispatchWorkflowCall(start: StartWorkflowTaskInput): Promise<{
  readonly result?: RuntimeActionResult;
  readonly session: HarnessSession;
  readonly started?: TaskStartedStreamEvent;
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
