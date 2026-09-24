import { getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import type { RuntimeActionResultHookPayload, TaskStartedHookPayload } from "#channel/types.js";
import type { SessionStateCursor } from "#execution/session/state-cursor.js";
import type { SessionInboxHandle, SessionInboxPayload } from "#execution/session-inbox/inbox.js";
import { emitSubagentEventStep } from "#tasks/emit-event-step.js";
import type { WorkflowToolRunOutcomeMessage } from "#execution/tools/workflow/messages.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import type { RuntimeToolResultActionResult } from "#shared/action-types.js";
import { hasPendingAgentTaskCalls } from "#tasks/agent-tool.js";
import { applyTaskDeadlinesStep } from "#tasks/deadlines.js";
import type { WaitedTaskChanges } from "#tasks/detach.js";
import { detachWaitedTasksStep } from "#tasks/detach-step.js";
import type { TaskDeadlineSignal } from "#tasks/protocol.js";
import { hasStartingChildren, planTaskTimer } from "#tasks/state.js";
import { armTaskTimerStep, cancelTaskTimerStep } from "#tasks/timer-steps.js";
import { cancelTasksStep, type TaskCancelSelector } from "#tasks/cancel.js";
import {
  applyTaskReportStep,
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
 *
 * A `ctx.agent` caller's reply goes out while the events are published, so
 * its workflow run resumes at once. The run can only answer through this
 * owner's inbox, which the owner reads again after this update returns, so
 * the events still precede anything the run causes on the stream.
 */
export async function applyTaskOwnerUpdate(
  cursor: SessionStateCursor,
  update: TaskOwnerUpdate,
): Promise<readonly RuntimeToolResultActionResult[]> {
  await cursor.apply(update);
  await Promise.all([
    ...update.replies.map((reply) =>
      resumeHookStep(
        reply.replyTo,
        { kind: "runtime-action-result", results: [reply.result] },
        { ifPresent: true },
      ),
    ),
    publishTaskEvents(cursor, update.events),
  ]);
  return update.results;
}

async function publishTaskEvents(
  cursor: SessionStateCursor,
  events: TaskOwnerUpdate["events"],
): Promise<void> {
  await syncTaskTimer(cursor);
  for (const event of events) {
    await cursor.apply(
      await emitSubagentEventStep({
        event,
        sessionWritable: cursor.sessionWritable,
        serializedContext: cursor.serializedContext,
        sessionState: cursor.sessionState,
      }),
    );
  }
}

/** Starts the agent calls in the pending coordination batch and returns their immediate results. */
export async function startPendingAgentTasks(
  cursor: SessionStateCursor,
): Promise<readonly RuntimeToolResultActionResult[]> {
  if (!hasPendingAgentTaskCalls(cursor.sessionState.snapshot.session.state)) return [];
  return await startAgentTasks(cursor, undefined);
}

/** Starts agent calls; `undefined` starts the agent calls in the pending coordination batch. */
export async function startAgentTasks(
  cursor: SessionStateCursor,
  calls: readonly AgentTaskCall[] | undefined,
): Promise<readonly RuntimeToolResultActionResult[]> {
  const start = () =>
    startAgentTasksStep({
      calls,
      serializedContext: cursor.serializedContext,
      sessionState: cursor.sessionState,
    });
  let update = await start();
  if (update.callbackAliasMinted === true) {
    // Claimed before any remote child exists that could call back on it.
    await cursor.apply(update);
    update = await start();
  }
  return await applyTaskOwnerUpdate(cursor, update);
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

/**
 * Ends the owner's inbox with its session. A child still starting may have
 * reported its address just as the session ended, in a report the owner never
 * read. When a child is starting, the inbox is released first, which commits
 * its end and returns every report it accepted: each child that reported is
 * adopted, so a cancel held for it is sent and the session end reaches it. A
 * child that reports later finds its owner gone and exits.
 */
export async function closeTaskOwnerInbox(
  cursor: SessionStateCursor,
  inbox: Pick<SessionInboxHandle, "dispose" | "release">,
): Promise<void> {
  let unread: readonly SessionInboxPayload[] = [];
  try {
    if (hasStartingChildren(cursor.sessionState.snapshot.session)) unread = await inbox.release();
  } finally {
    await inbox.dispose();
  }
  for (const payload of unread) {
    if (payload.kind === "task.started") await applyTaskReport(cursor, payload);
  }
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
