/**
 * Starts workflow tool calls in pending coordination as tasks and applies the
 * model's `task_wait` and `task_cancel` calls. Agent calls start separately.
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
import { readContext, type TaskOwnerUpdate } from "#tasks/owner.js";
import { runCommands, type CommandEffect } from "#tasks/transport.js";
import { applyTaskWaitCall, type TaskWaitRegistration } from "#tasks/wait.js";
import { isTaskWaitRequest } from "#tasks/wait-tool.js";
import { startWorkflowTask } from "#tasks/workflow-task.js";

type CoordinationDispatchStepInput = CoordinationDispatchInput & {
  readonly action: "park";
};

export async function dispatchCoordinationStep(input: CoordinationDispatchStepInput): Promise<
  TaskOwnerUpdate & {
    /** The `task_wait` calls the turn holds for. */
    readonly taskWaits?: readonly TaskWaitRegistration[];
  }
> {
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
  const taskWaits: TaskWaitRegistration[] = [];

  for (const request of prepared.plan) {
    if (isAgentTaskRequest(request) || isTaskWaitRequest(request) || isTaskCancelRequest(request)) {
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
  // Waits register before cancels, so a wait on a task cancelled in the same
  // step gets the cancellation, whatever the calls' order.
  const alreadyWaited = new Set<string>();
  for (const request of prepared.plan.filter(isTaskWaitRequest)) {
    const waited = applyTaskWaitCall({
      alreadyWaited,
      caller: prepared.auth,
      now,
      request,
      session: nextSession,
    });
    nextSession = waited.session;
    if (waited.result !== undefined) results.push(waited.result);
    if (waited.wait !== undefined) taskWaits.push(waited.wait);
    if (waited.waitedTaskId !== undefined) alreadyWaited.add(waited.waitedTaskId);
  }
  for (const request of prepared.plan.filter(isTaskCancelRequest)) {
    const cancelled = applyTaskCancelCall({
      caller: prepared.auth,
      now,
      request,
      session: nextSession,
    });
    nextSession = cancelled.session;
    commands.push(...cancelled.commands);
    events.push(...cancelled.events);
    results.push(...cancelled.results);
  }
  if (commands.length > 0) {
    await runCommands(commands, await readContext(input.serializedContext));
  }

  return {
    events,
    replies: [],
    results,
    serializedContext: input.serializedContext,
    taskWaits,
    sessionState:
      nextSession === session
        ? prepared.sessionState
        : createDurableSessionState({ session: nextSession }),
  };
}
