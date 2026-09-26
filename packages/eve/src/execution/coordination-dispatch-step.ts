/** Starts workflow-tool runs for pending coordination. */

import {
  prepareCoordinationDispatch,
  type CoordinationDispatchInput,
  type CoordinationDispatchResult,
} from "#execution/coordination-dispatch-shared.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import { startWorkflowTask, type StartWorkflowTaskInput } from "#execution/tools/workflow/start.js";
import { sendToTask, startTaskRun } from "#execution/tasks/start.js";
import { captureAgentSessionContext } from "#execution/agent-sessions/context.js";
import type { RuntimeActionResult } from "#shared/action-types.js";
import type { RuntimeSession } from "#subagents/handle-dispatch.js";

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
    const started = await dispatchWorkflowCall(start, input.sessionWritable);
    nextSession = started.session;
    if (started.result !== undefined) results.push(started.result);
  }

  return {
    results,
    sessionState:
      nextSession === session
        ? prepared.sessionState
        : createDurableSessionState({ session: nextSession }),
  };
}

/**
 * Starts the run the call's entry point names, or sends a call with `taskId`
 * to the running `serve` task it names.
 */
async function dispatchWorkflowCall(
  start: StartWorkflowTaskInput,
  sessionWritable: WritableStream<Uint8Array>,
): Promise<{ readonly result?: RuntimeActionResult; readonly session: RuntimeSession }> {
  const { entry } = start.task;
  switch (entry.entryPoint) {
    case "execute":
      return await startWorkflowTask(start);
    case "task":
    case "serve":
      return await startTaskRun({ ...start, entry, sessionWritable });
    case "receive":
      return await sendToTask({ ...start, sessionWritable, taskId: entry.taskId });
  }
}
