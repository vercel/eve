/** Starts ordinary workflow-tool runs for pending blocking actions. */

import {
  prepareCoordinationDispatch,
  startWorkflowTask,
  type CoordinationDispatchInput,
  type CoordinationDispatchResult,
} from "#execution/coordination-dispatch-shared.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import { executeTaskControlAction } from "#execution/tasks/parent/dispatch.js";
import type { BackgroundTask } from "#execution/tasks/parent/delegate.js";
import { cancelBackgroundAgentTask } from "#subagents/task-cancel.js";
import type { RuntimeActionResult } from "#shared/action-types.js";

export async function dispatchCoordinationStep(
  input: CoordinationDispatchInput,
): Promise<CoordinationDispatchResult> {
  "use step";

  const prepared = await prepareCoordinationDispatch({
    serializedContext: input.serializedContext,
    sessionState: input.sessionState,
  });
  if (prepared === undefined) {
    return { results: [], sessionState: input.sessionState, pendingTasks: [] };
  }

  const { batch, session } = prepared;
  let nextSession = session;
  const results: RuntimeActionResult[] = [];
  const pendingTasks: BackgroundTask[] = [];

  for (const entry of prepared.plan) {
    if (entry.kind === "reject") {
      results.push(entry.result);
      continue;
    }
    if (entry.kind === "workflow-task") {
      const started = await startWorkflowTask({
        batchEvent: batch.event,
        parentContinuationToken: input.parentContinuationToken ?? session.continuationToken,
        prepared,
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

    throw new Error("Agent dispatch must be owned by a workflow task.");
  }

  return {
    results,
    sessionState:
      nextSession === session
        ? input.sessionState
        : createDurableSessionState({ session: nextSession }),
    pendingTasks,
  };
}
