import type { RuntimeActionResultHookPayload, TaskStartedHookPayload } from "#channel/types.js";
import type { SessionStateCursor } from "#execution/session/state-cursor.js";
import { emitSubagentEventStep } from "#execution/tools/subagent/emit-event-step.js";
import type { WorkflowToolRunOutcomeMessage } from "#execution/tools/workflow/messages.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import type { RuntimeToolResultActionResult } from "#shared/action-types.js";
import { hasPendingAgentTaskCalls } from "#tasks/agent-tool.js";
import { readTaskCallbackAlias } from "#tasks/state.js";
import {
  applyTaskReportStep,
  cancelTasksStep,
  ensureTaskCallbackAliasStep,
  startAgentTasksStep,
  type AgentTaskCall,
  type TaskCancelSelector,
  type TaskOwnerUpdate,
} from "#tasks/owner.js";
import { settleWorkflowTaskStep } from "#tasks/workflow-task.js";

// Owner-side helpers that run in the session workflow body. They only
// sequence steps, and must not import Node.js built-ins.

/** Adopts an owner step's state, publishes its events, and answers `ctx.agent` callers. */
export async function applyTaskOwnerUpdate(
  cursor: SessionStateCursor,
  update: TaskOwnerUpdate,
): Promise<readonly RuntimeToolResultActionResult[]> {
  await cursor.apply(update);
  for (const event of update.events) {
    await cursor.apply(
      await emitSubagentEventStep({
        event,
        sessionWritable: cursor.sessionWritable,
        serializedContext: cursor.serializedContext,
        sessionState: cursor.sessionState,
      }),
    );
  }
  for (const reply of update.replies) {
    await resumeHookStep(
      reply.replyTo,
      { kind: "runtime-action-result", results: [reply.result] },
      { ifPresent: true },
    );
  }
  return update.results;
}

/** Starts the agent calls in the pending coordination batch and returns their immediate results. */
export async function startPendingAgentTasks(
  cursor: SessionStateCursor,
): Promise<readonly RuntimeToolResultActionResult[]> {
  if (!hasPendingAgentTaskCalls(cursor.sessionState.snapshot.session.state)) return [];
  await ensureTaskCallbackAlias(cursor);
  return await applyTaskOwnerUpdate(
    cursor,
    await startAgentTasksStep({
      serializedContext: cursor.serializedContext,
      sessionState: cursor.sessionState,
    }),
  );
}

export async function startAgentTasks(
  cursor: SessionStateCursor,
  calls: readonly AgentTaskCall[],
): Promise<readonly RuntimeToolResultActionResult[]> {
  await ensureTaskCallbackAlias(cursor);
  return await applyTaskOwnerUpdate(
    cursor,
    await startAgentTasksStep({
      calls,
      serializedContext: cursor.serializedContext,
      sessionState: cursor.sessionState,
    }),
  );
}

/** Applies one child report and returns tool results for waited calls it settled. */
export async function applyTaskReport(
  cursor: SessionStateCursor,
  payload: RuntimeActionResultHookPayload | TaskStartedHookPayload,
): Promise<readonly RuntimeToolResultActionResult[]> {
  return await applyTaskOwnerUpdate(
    cursor,
    await applyTaskReportStep({
      payload,
      serializedContext: cursor.serializedContext,
      sessionState: cursor.sessionState,
    }),
  );
}

/** Applies a workflow tool run's outcome and returns the tool result of the call it settled. */
export async function settleWorkflowTask(
  cursor: SessionStateCursor,
  message: WorkflowToolRunOutcomeMessage,
): Promise<readonly RuntimeToolResultActionResult[]> {
  return await applyTaskOwnerUpdate(
    cursor,
    await settleWorkflowTaskStep({
      message,
      serializedContext: cursor.serializedContext,
      sessionState: cursor.sessionState,
    }),
  );
}

/**
 * Cancels the agent tasks and workflow tool calls the active turn is waiting
 * on, without waiting for their children to stop.
 */
export async function cancelTurnDescendants(cursor: SessionStateCursor): Promise<void> {
  await cancelTasks(cursor, { kind: "active-turn" });
}

/** Cancels the selected working tasks and publishes their `task.settled` events. */
export async function cancelTasks(
  cursor: SessionStateCursor,
  selector: TaskCancelSelector,
): Promise<void> {
  await applyTaskOwnerUpdate(
    cursor,
    await cancelTasksStep({
      selector,
      serializedContext: cursor.serializedContext,
      sessionState: cursor.sessionState,
    }),
  );
}

/** Records and claims the remote callback alias before any child can call back on it. */
async function ensureTaskCallbackAlias(cursor: SessionStateCursor): Promise<void> {
  if (readTaskCallbackAlias(cursor.sessionState.snapshot.session.state) !== undefined) return;
  await cursor.apply(await ensureTaskCallbackAliasStep({ sessionState: cursor.sessionState }));
}
