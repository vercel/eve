/**
 * Starts workflow tool calls in pending coordination as tasks and applies the
 * model's calls that stop background tasks. Agent calls start separately.
 */

import {
  prepareCoordinationDispatch,
  type CoordinationDispatchInput,
} from "#execution/coordination-dispatch-shared.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import { startWorkflowToolRun } from "#execution/tools/workflow/start.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { RuntimeToolResultActionResult } from "#shared/action-types.js";
import { isAgentTaskRequest } from "#tasks/agent-tool.js";
import { applyTaskCancelCall } from "#tasks/cancel.js";
import { isTaskCancelRequest } from "#tasks/cancel-tool.js";
import { planTaskWait, type TaskWaitPlan } from "#tasks/detach.js";
import { readContext, type TaskOwnerUpdate } from "#tasks/owner.js";
import { readTasks } from "#tasks/read.js";
import { setTaskTable } from "#tasks/state.js";
import { runCommands, type CommandEffect } from "#tasks/transport.js";
import { startWorkflowTask } from "#tasks/workflow-task.js";

type CoordinationDispatchStepInput = CoordinationDispatchInput & {
  readonly action: "park";
};

export async function dispatchCoordinationStep(
  input: CoordinationDispatchStepInput,
): Promise<TaskOwnerUpdate & { readonly wait?: TaskWaitPlan }> {
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
  const commands: CommandEffect[] = [];

  for (const request of prepared.plan) {
    if (isAgentTaskRequest(request)) continue;
    if (isTaskCancelRequest(request)) {
      const table = readTasks(nextSession);
      const cancelled = applyTaskCancelCall(table, request, now);
      if (cancelled.table !== table) nextSession = setTaskTable(nextSession, cancelled.table);
      commands.push(...cancelled.commands);
      events.push(...cancelled.events);
      results.push(cancelled.result);
      continue;
    }
    const started = await startWorkflowTask({
      creator: prepared.creator,
      now,
      request,
      session: nextSession,
      startRun: (record) =>
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
          taskId: record.id,
          toolName: request.toolName,
          workflowId: request.workflowId,
        }),
      turnId: batch.event.turnId,
    });
    nextSession = started.session;
    events.push(...started.events);
    if (started.result !== undefined) results.push(started.result);
  }
  if (commands.length > 0) {
    await runCommands(commands, await readContext(input.serializedContext));
  }

  return {
    events,
    replies: [],
    results,
    serializedContext: input.serializedContext,
    wait: planTaskWait({ detachable: prepared.interactiveRootTurn, requests: prepared.plan }),
    sessionState:
      nextSession === session
        ? prepared.sessionState
        : createDurableSessionState({ session: nextSession }),
  };
}
