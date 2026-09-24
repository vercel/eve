import { getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import type { RuntimeActionResultHookPayload, TaskStartedHookPayload } from "#channel/types.js";
import type { SessionStateCursor } from "#execution/session/state-cursor.js";
import { emitSubagentEventStep } from "#execution/tools/subagent/emit-event-step.js";
import type { WorkflowToolRunOutcomeMessage } from "#execution/tools/workflow/messages.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import type { RuntimeToolResultActionResult } from "#shared/action-types.js";
import { hasPendingAgentTaskCalls } from "#tasks/agent-tool.js";
import { applyTaskDeadlinesStep } from "#tasks/deadlines.js";
import type { WaitedTaskChanges } from "#tasks/detach.js";
import { detachWaitedTasksStep } from "#tasks/detach-step.js";
import type { TaskDeadlineSignal } from "#tasks/protocol.js";
import { planTaskTimer, readTaskCallbackAlias } from "#tasks/state.js";
import { armTaskTimerStep, cancelTaskTimerStep } from "#tasks/timer-steps.js";
import { cancelTasksStep, type TaskCancelSelector } from "#tasks/cancel.js";
import {
  applyTaskReportStep,
  ensureTaskCallbackAliasStep,
  startAgentTasksStep,
  type AgentTaskCall,
  type TaskOwnerUpdate,
} from "#tasks/owner.js";
import { settleWorkflowTaskStep } from "#tasks/workflow-task.js";

// Owner-side helpers that run in the session workflow body. They only
// sequence steps, and must not import Node.js built-ins.

/**
 * Adopts an owner step's state, publishes its events, answers `ctx.agent`
 * callers, and arms the owner's timer if the table now needs an earlier wake.
 */
export async function applyTaskOwnerUpdate(
  cursor: SessionStateCursor,
  update: TaskOwnerUpdate,
): Promise<readonly RuntimeToolResultActionResult[]> {
  await cursor.apply(update);
  await syncTaskTimer(cursor);
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

/**
 * Detaches or ends waited calls after a steering message or a detach timer.
 * Returns their tool results: receipts for detached calls, and the time
 * waited for each `sleep` that ended early.
 */
export async function interruptWaitedTasks(
  cursor: SessionStateCursor,
  changes: WaitedTaskChanges,
): Promise<readonly RuntimeToolResultActionResult[]> {
  return await applyTaskOwnerUpdate(
    cursor,
    await detachWaitedTasksStep({
      ...changes,
      serializedContext: cursor.serializedContext,
      sessionState: cursor.sessionState,
    }),
  );
}

/**
 * Applies the owner timer's signal: times out due tasks and hard-stops
 * children that did not confirm a cancel. Returns tool results for waited
 * calls it settled.
 */
export async function applyTaskDeadline(
  cursor: SessionStateCursor,
  signal: TaskDeadlineSignal,
): Promise<readonly RuntimeToolResultActionResult[]> {
  return await applyTaskOwnerUpdate(
    cursor,
    await applyTaskDeadlinesStep({
      serializedContext: cursor.serializedContext,
      sessionState: cursor.sessionState,
      signal,
    }),
  );
}

/**
 * Keeps the owner's timer in line with the task table. It arms when the
 * table needs an earlier wake, when a predecessor run armed the timer, or
 * when the armed timer's signal is overdue, and cancels it once nothing is
 * due. Arming only earlier keeps one live timer in the common case; a timer
 * that fires with nothing due is cleared and the next deadline re-arms.
 */
export async function syncTaskTimer(cursor: SessionStateCursor): Promise<void> {
  const plan = planTaskTimer(cursor.sessionState.snapshot.session.state, {
    nowMs: Date.now(),
    // Read only when a timer is armed, so an owner with no deadlines skips it.
    get ownerRunId() {
      return getWorkflowMetadata().workflowRunId;
    },
  });
  if (plan.kind === "arm") {
    await cursor.apply(
      await armTaskTimerStep({ sessionState: cursor.sessionState, wakeAt: plan.wakeAt }),
    );
  } else if (plan.kind === "cancel") {
    await cursor.apply(await cancelTaskTimerStep({ sessionState: cursor.sessionState }));
  }
}

/** Records and claims the remote callback alias before any child can call back on it. */
async function ensureTaskCallbackAlias(cursor: SessionStateCursor): Promise<void> {
  if (readTaskCallbackAlias(cursor.sessionState.snapshot.session.state) !== undefined) return;
  await cursor.apply(await ensureTaskCallbackAliasStep({ sessionState: cursor.sessionState }));
}
