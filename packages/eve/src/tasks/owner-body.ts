import { getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import type {
  DeliverHookPayload,
  RuntimeActionResultHookPayload,
  TaskStartedHookPayload,
} from "#channel/types.js";
import type { SessionStateCursor } from "#execution/session/state-cursor.js";
import type { SessionInboxHandle, SessionInboxPayload } from "#execution/session-inbox/inbox.js";
import { emitSubagentEventStep } from "#tasks/emit-event-step.js";
import type {
  WorkflowToolRunGenerationMessage,
  WorkflowToolRunOutcomeMessage,
} from "#execution/tools/workflow/messages.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import type { RuntimeToolResultActionResult } from "#shared/action-types.js";
import { flushUnsentCallerEvents } from "#subagents/remote/unsent-caller-events.js";
import { hasPendingAgentTaskCalls } from "#tasks/agent-tool.js";
import { applyTaskDeadlinesStep } from "#tasks/deadlines.js";
import {
  hasOwnPendingInput,
  hasPendingTaskInput,
  planTaskAnswers,
  taskInputResolutions,
  withdrawnTaskInput,
  type TaskInputPublication,
} from "#tasks/input.js";
import { answerTaskStep, publishTaskInputStep, surfaceTaskInputStep } from "#tasks/input-step.js";
import type { TaskDeadlineSignal, TaskInputEvent } from "#tasks/protocol.js";
import { getTaskTable, hasStartingChildren, planTaskTimer } from "#tasks/state.js";
import { armTaskTimerStep, cancelTaskTimerStep } from "#tasks/timer-steps.js";
import {
  cancelTasksStep,
  endTasksStep,
  interruptAttachedCallsStep,
  type TaskCancelSelector,
} from "#tasks/cancel.js";
import { terminateChildSessionsStep } from "#execution/terminate-child-sessions-step.js";
import {
  applyTaskReportStep,
  startAgentTasksStep,
  type AgentTaskCall,
  type TaskOwnerUpdate,
} from "#tasks/owner.js";
import { endTaskWaitsStep, type TaskWaitEnd } from "#tasks/wait.js";
import { applyWorkflowGenerationStep, settleWorkflowTaskStep } from "#tasks/workflow-task.js";
import { hasCancellableWork } from "#tasks/table.js";
import { hasEnded } from "#tasks/record.js";
import { readPendingTaskResults } from "#tasks/results.js";

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
 *
 * Every owner transition passes here, so this is the one place requests are
 * withdrawn: a request a task no longer waits on after the update, because
 * the task was cancelled, timed out, or settled, is published as
 * `input.resolved` with `ignored`, and reaches this session's caller like a
 * child's own resolution. A child's resolutions and the owner's answers
 * change a task's requests only through `surfaceTaskInput` and
 * `answerTaskInput`, which publish their own events.
 */
export async function applyTaskOwnerUpdate(
  cursor: SessionStateCursor,
  update: TaskOwnerUpdate,
): Promise<readonly RuntimeToolResultActionResult[]> {
  const before = getTaskTable(cursor.sessionState.snapshot.session);
  await cursor.apply(update);
  const after = getTaskTable(cursor.sessionState.snapshot.session);
  await Promise.all([
    ...update.replies.map((reply) =>
      resumeHookStep(
        reply.replyTo,
        { kind: "runtime-action-result", results: [reply.result] },
        { ifPresent: true },
      ),
    ),
    publishTaskEvents(
      cursor,
      update.events,
      taskInputResolutions(withdrawnTaskInput(before, after)),
    ),
  ]);
  return update.results;
}

async function publishTaskEvents(
  cursor: SessionStateCursor,
  events: TaskOwnerUpdate["events"],
  withdrawn: readonly TaskInputPublication[],
): Promise<void> {
  await syncTaskTimer(cursor);
  await publishTaskInput(cursor, withdrawn);
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
 * Applies one generation message of a resumable workflow run and returns the
 * results of `task_wait` calls it settled.
 */
export async function applyWorkflowGeneration(
  cursor: SessionStateCursor,
  message: WorkflowToolRunGenerationMessage,
): Promise<readonly RuntimeToolResultActionResult[]> {
  return await applyTaskOwnerUpdate(
    cursor,
    await applyWorkflowGenerationStep({
      message,
      serializedContext: cursor.serializedContext,
      sessionState: cursor.sessionState,
    }),
  );
}

/**
 * Cancels the selected working tasks, without waiting for their children to
 * stop, and publishes their `task.settled` events. Returns the results of
 * `task_wait` calls on the cancelled tasks. With no working task it takes no
 * step.
 */
export async function cancelTasks(
  cursor: SessionStateCursor,
  selector: TaskCancelSelector,
): Promise<readonly RuntimeToolResultActionResult[]> {
  const session = cursor.sessionState.snapshot.session;
  if (
    !getTaskTable(session).records.some(hasCancellableWork) &&
    readPendingTaskResults(session.state).length === 0
  ) {
    return [];
  }
  return await applyTaskOwnerUpdate(
    cursor,
    await cancelTasksStep({
      selector,
      serializedContext: cursor.serializedContext,
      sessionState: cursor.sessionState,
    }),
  );
}

/**
 * Ends every task as the session ends: cancels the working ones, asks every
 * child to stop while the table still names it, then ends each task, which
 * publishes its `task.ended`. Nothing is delivered afterwards.
 */
export async function endSessionTasks(cursor: SessionStateCursor): Promise<void> {
  try {
    await cancelTasks(cursor, { kind: "all" });
  } finally {
    await terminateChildSessionsStep({
      serializedContext: cursor.serializedContext,
      sessionState: cursor.sessionState,
    });
  }
  if (getTaskTable(cursor.sessionState.snapshot.session).records.every(hasEnded)) return;
  await applyTaskOwnerUpdate(
    cursor,
    await endTasksStep({
      serializedContext: cursor.serializedContext,
      sessionState: cursor.sessionState,
    }),
  );
}

/**
 * Ends `task_wait` calls that got no result: the given calls, or every wait
 * when `callIds` is absent. Returns their tool results; a cancelled turn's
 * waits get none. A given call gets its result even when no record points at
 * it any more, so the step runs whenever calls are named.
 */
export async function endTaskWaits(
  cursor: SessionStateCursor,
  input: { readonly callIds?: readonly string[]; readonly reason: TaskWaitEnd },
): Promise<readonly RuntimeToolResultActionResult[]> {
  const table = getTaskTable(cursor.sessionState.snapshot.session);
  if (input.callIds === undefined && !table.records.some((record) => record.wait !== undefined)) {
    return [];
  }
  return await applyTaskOwnerUpdate(
    cursor,
    await endTaskWaitsStep({
      ...input,
      serializedContext: cursor.serializedContext,
      sessionState: cursor.sessionState,
    }),
  );
}

/**
 * Ends the given attached calls of the active turn after a steering message,
 * or after a dismissed call's grace period: a `task_wait` returns
 * `interrupted`, and an attached workflow tool is cancelled. Returns their
 * tool results. Detached tasks keep working.
 */
export async function interruptAttachedCalls(
  cursor: SessionStateCursor,
  callIds: readonly string[],
): Promise<readonly RuntimeToolResultActionResult[]> {
  return await applyTaskOwnerUpdate(
    cursor,
    await interruptAttachedCallsStep({
      callIds,
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
 * Surfaces a child's human-input event for its task and passes it on to this
 * session's caller at once: a question must not wait for the next input.
 * Returns the requested IDs it refused (see `admitTaskInputEvent`).
 */
export async function surfaceTaskInput(
  cursor: SessionStateCursor,
  taskId: string,
  event: TaskInputEvent,
): Promise<readonly string[]> {
  const surfaced = await surfaceTaskInputStep({
    event,
    serializedContext: cursor.serializedContext,
    sessionState: cursor.sessionState,
    sessionWritable: cursor.sessionWritable,
    taskId,
  });
  await cursor.apply(surfaced);
  await syncTaskTimer(cursor);
  await flushUnsentCallerEvents(cursor);
  return surfaced.refused;
}

/** Publishes input events the owner decided for its tasks, as `surfaceTaskInput` does a child's. */
async function publishTaskInput(
  cursor: SessionStateCursor,
  events: readonly TaskInputPublication[],
): Promise<void> {
  if (events.length === 0) return;
  await cursor.apply(
    await publishTaskInputStep({
      events,
      serializedContext: cursor.serializedContext,
      sessionState: cursor.sessionState,
      sessionWritable: cursor.sessionWritable,
    }),
  );
  await syncTaskTimer(cursor);
  await flushUnsentCallerEvents(cursor);
}

/** Where a delivery goes once its answers for tasks are sent. */
export type TaskAnswerRouting =
  | { readonly kind: "cancel-turn" }
  | {
      readonly kind: "continue";
      /** What stays with this session; `undefined` when the answers used up the delivery. */
      readonly remainder: DeliverHookPayload | undefined;
      /** Calls whose task's dismissible question a person's message dismissed. */
      readonly dismissedCallIds?: readonly string[];
    };

/**
 * Sends the answers a delivery holds for tasks to the children that asked
 * (see `planTaskAnswers`), then publishes the requests the sent answers
 * resolved (see `sentAnswerResolutions`), which no later delivery can
 * answer. Without pending task input it takes no step. `steers` says whether
 * the delivery steers or starts a turn (see `planTaskAnswers`).
 */
export async function answerTaskInput(
  cursor: SessionStateCursor,
  delivery: DeliverHookPayload,
  options: { readonly steers: boolean },
): Promise<TaskAnswerRouting> {
  const session = cursor.sessionState.snapshot.session;
  if (!hasPendingTaskInput(session)) return { kind: "continue", remainder: delivery };
  const plan = planTaskAnswers({
    delivery,
    sessionAsks: hasOwnPendingInput(session.state),
    steers: options.steers,
    table: getTaskTable(session),
  });
  if (plan.answers.length > 0) {
    const sent = await Promise.all(
      plan.answers.map((answers) =>
        answerTaskStep({
          answers,
          delivery,
          serializedContext: cursor.serializedContext,
          sessionId: cursor.sessionState.sessionId,
        }),
      ),
    );
    await publishTaskInput(cursor, sent.flat());
  }
  if (plan.cancelTurn) return { kind: "cancel-turn" };
  const dismissedCallIds = plan.answers.flatMap((answers) =>
    answers.dismissed.length === 0 ? [] : [answers.record.callId],
  );
  return { dismissedCallIds, kind: "continue", remainder: plan.remainder };
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
