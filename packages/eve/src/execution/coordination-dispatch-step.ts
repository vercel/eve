/** Starts workflow tool calls in pending coordination as tasks. Agent calls start separately. */

import {
  prepareCoordinationDispatch,
  type CoordinationDispatchInput,
} from "#execution/coordination-dispatch-shared.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import { startWorkflowToolRun } from "#execution/tools/workflow/start.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { RuntimeToolResultActionResult } from "#shared/action-types.js";
import { isAgentTaskRequest } from "#tasks/agent-tool.js";
import type { TaskOwnerUpdate } from "#tasks/owner.js";
import { startWorkflowTask } from "#tasks/workflow-task.js";

type CoordinationDispatchStepInput = CoordinationDispatchInput & {
  readonly action: "park";
};

export async function dispatchCoordinationStep(
  input: CoordinationDispatchStepInput,
): Promise<TaskOwnerUpdate> {
  "use step";

  const prepared = await prepareCoordinationDispatch({
    serializedContext: input.serializedContext,
    sessionState: input.sessionState,
  });
  if (prepared === undefined) {
    return {
      events: [],
      replies: [],
      results: [],
      serializedContext: input.serializedContext,
      sessionState: input.sessionState,
    };
  }

  const { batch, session } = prepared;
  const now = new Date().toISOString();
  let nextSession = session;
  const events: UnstampedMessageStreamEvent[] = [];
  const results: RuntimeToolResultActionResult[] = [];

  for (const request of prepared.plan) {
    if (isAgentTaskRequest(request)) continue;
    const started = await startWorkflowTask({
      now,
      request,
      session: nextSession,
      startRun: () =>
        startWorkflowToolRun({
          agents: prepared.workflowAgents,
          callId: request.callId,
          canRequestInput: prepared.capabilities?.requestInput === true,
          executeInput: request.executeInput,
          input: request.input,
          owner: input.workflowToolRunOwner,
          session: {
            auth: { current: prepared.auth, initiator: prepared.initiatorAuth },
            id: session.sessionId,
            parent: prepared.parentSession,
            turn: { id: batch.event.turnId, sequence: batch.event.sequence },
          },
          stepIndex: batch.event.stepIndex,
          toolName: request.toolName,
          workflowId: request.workflowId,
        }),
      turnId: batch.event.turnId,
    });
    nextSession = started.session;
    events.push(...started.events);
    if (started.result !== undefined) results.push(started.result);
  }

  return {
    events,
    replies: [],
    results,
    serializedContext: input.serializedContext,
    sessionState:
      nextSession === session
        ? prepared.sessionState
        : createDurableSessionState({ session: nextSession }),
  };
}
