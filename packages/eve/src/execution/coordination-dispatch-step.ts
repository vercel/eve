/** Starts workflow-tool runs for pending blocking actions from the model tool loop. */

import {
  prepareCoordinationDispatch,
  type CoordinationDispatchInput,
  type CoordinationDispatchResult,
} from "#execution/coordination-dispatch-shared.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import { executeTaskControlAction } from "#execution/tasks/parent/dispatch.js";
import type { BackgroundTask } from "#execution/tasks/parent/delegate.js";
import { cancelBackgroundAgentTask } from "#execution/tools/subagent/task-cancel.js";
import { deliverTaskUpdate } from "#execution/tasks/child/update.js";
import { startWorkflowTask } from "#execution/tools/workflow/start.js";
import type { RuntimeActionResult } from "#shared/action-types.js";

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
      pendingTasks: [],
    };
  }

  const { batch, session } = prepared;
  let nextSession = session;
  const results: RuntimeActionResult[] = [];
  const pendingTasks: BackgroundTask[] = [];

  for (const entry of prepared.plan) {
    if (entry.kind === "workflow-task") {
      const started = await startWorkflowTask({
        auth: prepared.auth,
        batchEvent: batch.event,
        codeMode: {
          serializedContext: prepared.serializedContext,
          sessionState: createDurableSessionState({ session: nextSession }),
        },
        initiatorAuth: prepared.initiatorAuth,
        owner: input.workflowToolRunOwner,
        parentSession: prepared.parentSession,
        session: nextSession,
        task: entry.task,
      });
      nextSession = started.session;
      if (started.result !== undefined) results.push(started.result);
      continue;
    }
    if (entry.kind === "task-control") {
      const control = await executeTaskControlAction({
        action: entry.action,
        adapter: prepared.adapter,
        bundle: prepared.bundle,
        cancelOwnedWork: cancelBackgroundAgentTask,
        deliverUpdate: deliverTaskUpdate,
        parentStepIndex: batch.event.stepIndex,
        parentTurnId: batch.event.turnId,
        serializedContext: prepared.serializedContext,
        session: nextSession,
      });
      nextSession = control.session;
      if (control.pendingTask !== undefined) pendingTasks.push(control.pendingTask);
      results.push(control.result);
      continue;
    }
  }

  return {
    results,
    sessionState:
      nextSession === session
        ? prepared.sessionState
        : createDurableSessionState({ session: nextSession }),
    pendingTasks,
  };
}
