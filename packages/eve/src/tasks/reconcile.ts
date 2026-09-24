import { readDurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import type { WorkflowToolRunOutcomeMessage } from "#execution/tools/workflow/messages.js";
import { createLogger, logError } from "#internal/logging.js";
import { getRun } from "#internal/workflow/runtime.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { RuntimeToolResultActionResult } from "#shared/action-types.js";
import { EXECUTION_FAILED } from "#subagents/agent-handle-errors.js";
import {
  applyTaskReport,
  readContext,
  type TaskOwnerUpdate,
  type WorkflowCallerReply,
} from "#tasks/owner.js";
import { isTerminalTaskStatus, reportedAnswer } from "#tasks/protocol.js";
import type { TaskRecord } from "#tasks/record.js";
import { WORKFLOW_RUN_ENDED_WITHOUT_RESULT_MESSAGE } from "#tasks/render.js";
import { getTaskTable, readTaskCallbackAlias } from "#tasks/state.js";
import { readRemoteTaskReport } from "#tasks/transport.js";
import { settleWorkflowTask } from "#tasks/workflow-task.js";

// The deadline's reconciliation: before a task times out, the owner reads its
// child once. A child that already finished settles the task with its result,
// which covers a report that never arrived. A remote child is read over HTTP;
// a workflow tool run through its run's status and return value. A local
// agent is not read: it reports through the owner's stable inbox as a durable
// step, and the owner hands off only when no task is working, so its report
// cannot be lost while the owner lives.

const log = createLogger("tasks.reconcile");

export interface ReconciledTasks {
  readonly events: readonly UnstampedMessageStreamEvent[];
  readonly replies: readonly WorkflowCallerReply[];
  readonly results: readonly RuntimeToolResultActionResult[];
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

/** Reconciles every due remote and workflow task; the rest time out as usual. */
export async function reconcileDueTasks(input: {
  readonly now: string;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<ReconciledTasks> {
  const remote = await reconcileDueRemoteTasks(input);
  return await reconcileDueWorkflowTasks({ ...remote, now: input.now });
}

/**
 * Settles each due remote task whose child already reported an answer the
 * owner has not applied, through the same path as that child's callback. The
 * latest answer is one the owner already applied when the child has not
 * answered the current generation, such as an agent that runs a steering
 * message it received after answering; the task then times out as usual.
 */
async function reconcileDueRemoteTasks(input: {
  readonly now: string;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<ReconciledTasks> {
  const session = readDurableSession(input.sessionState);
  const due = getTaskTable(session).records.filter(
    (record) => record.child?.kind === "remote" && isDue(record, input.now),
  );
  let reconciled: ReconciledTasks = {
    events: [],
    replies: [],
    results: [],
    serializedContext: input.serializedContext,
    sessionState: input.sessionState,
  };
  const alias = readTaskCallbackAlias(session.state);
  if (due.length === 0 || alias === undefined) return reconciled;

  const ctx = await readContext(input.serializedContext);
  // The child keeps each report for the callback it was sent to, and shows it
  // only to the holder of that callback.
  const callbackToken = sessionInboxHookToken(alias);
  for (const record of due) {
    const result = await readRemoteTaskReport(record, ctx, callbackToken);
    if (result === undefined) continue;
    const answer = reportedAnswer(result);
    if (answer === undefined || answer <= (record.answerSeq ?? -1)) continue;
    const update = await applyTaskReport({
      now: input.now,
      payload: {
        kind: "runtime-action-result",
        results: [result],
        source: {
          kind: "remote",
          sessionId: record.child?.kind === "remote" ? record.child.sessionId : "",
        },
      },
      serializedContext: reconciled.serializedContext,
      sessionState: reconciled.sessionState,
    });
    reconciled = merge(reconciled, update);
  }
  return reconciled;
}

/**
 * Settles each due workflow task whose run already ended, through the same
 * path as the run's own outcome report. A run that completed returns the
 * outcome it reported; one that failed before reporting fails the task with
 * `EXECUTION_FAILED`; one that was stopped cancels it. A run still working,
 * or one that returned nothing, such as a duplicate start, times out.
 */
async function reconcileDueWorkflowTasks(
  input: ReconciledTasks & { readonly now: string },
): Promise<ReconciledTasks> {
  const due = getTaskTable(readDurableSession(input.sessionState)).records.filter(
    (record) => record.child?.kind === "workflow" && isDue(record, input.now),
  );
  let reconciled: ReconciledTasks = input;
  for (const record of due) {
    const message = await readEndedWorkflowRun(record);
    if (message === undefined) continue;
    const update = settleWorkflowTask({
      message,
      now: input.now,
      serializedContext: reconciled.serializedContext,
      sessionState: reconciled.sessionState,
    });
    reconciled = merge(reconciled, update);
  }
  return reconciled;
}

async function readEndedWorkflowRun(
  record: TaskRecord,
): Promise<WorkflowToolRunOutcomeMessage | undefined> {
  if (record.child?.kind !== "workflow") return undefined;
  const { runId } = record.child;
  try {
    const run = getRun<WorkflowToolRunOutcomeMessage | undefined>(runId);
    const status = await run.status;
    const from = {
      callId: record.callId,
      input: {},
      runId,
      sequence: 0,
      stepIndex: 0,
      taskId: record.id,
      toolName: record.name,
      turnId: record.turnId,
    };
    switch (status) {
      case "completed": {
        // The run already completed, so its return value is read once, not awaited.
        const message = await run.returnValue;
        return isOutcomeMessage(message) ? message : undefined;
      }
      case "failed":
        return {
          from,
          result: {
            error: { code: EXECUTION_FAILED, message: WORKFLOW_RUN_ENDED_WITHOUT_RESULT_MESSAGE },
            status: "failed",
          },
        };
      case "cancelled":
        return { from, result: { status: "cancelled" } };
      default:
        return undefined;
    }
  } catch (error) {
    // An unreadable run is treated as still working, so the task times out.
    logError(log, "failed to read a workflow task's run", error, {
      runId,
      taskId: record.id,
    });
    return undefined;
  }
}

function isOutcomeMessage(value: unknown): value is WorkflowToolRunOutcomeMessage {
  if (typeof value !== "object" || value === null) return false;
  const { from, result } = value as { from?: unknown; result?: unknown };
  if (typeof from !== "object" || from === null) return false;
  if (typeof result !== "object" || result === null) return false;
  const status = (result as { status?: unknown }).status;
  return status === "completed" || status === "failed" || status === "cancelled";
}

function isDue(record: TaskRecord, now: string): boolean {
  return (
    !isTerminalTaskStatus(record.status) &&
    record.clockStoppedAt === undefined &&
    record.deadlineAt !== undefined &&
    Date.parse(record.deadlineAt) <= Date.parse(now)
  );
}

function merge(reconciled: ReconciledTasks, update: TaskOwnerUpdate): ReconciledTasks {
  return {
    events: [...reconciled.events, ...update.events],
    replies: [...reconciled.replies, ...update.replies],
    results: [...reconciled.results, ...update.results],
    serializedContext: update.serializedContext,
    sessionState: update.sessionState,
  };
}
