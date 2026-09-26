import { deliverWorkflowAuthorization } from "#execution/tools/workflow/owner.js";
import {
  emitAgentStartedStep,
  emitWorkflowToolRunReportStep,
} from "#execution/tools/workflow/emit-workflow-tool-run-report-step.js";
import type {
  WorkflowToolRunMessage,
  WorkflowToolRunOutcomeMessage,
  WorkflowToolRunRef,
  WorkflowToolRunRequestMessage,
  WorkflowToolRunWithdrawMessage,
} from "#execution/tools/workflow/messages.js";
import { withdrawWorkflowToolRunQuestionStep } from "#execution/tools/workflow/withdraw-step.js";
import type { SessionStateCursor } from "#execution/session/state-cursor.js";
import {
  workflowToolRunOutcomeToToolResult,
  workflowToolRunRequestToInputRequestPayload,
} from "#execution/tools/workflow/owner-inbox.js";
import {
  findBlockingWorkflowToolRun,
  isInboxToolResultFromRecordedWorkflowToolRun,
} from "#harness/workflow-tool-runs.js";
import { runProxySubagentEventStep } from "#subagents/event-proxy-step.js";
import type { AnswerHookRoute } from "#harness/proxy-input-requests.js";
import type { RuntimeActionResult } from "#shared/action-types.js";
import type { SessionStateMap } from "#harness/types.js";
import { findTask, readTaskTable } from "#execution/tasks/table.js";

interface HandlerInput<T> {
  readonly cursor: SessionStateCursor;
  readonly message: T;
}

export async function handleWorkflowToolRunMessage(
  input: HandlerInput<WorkflowToolRunMessage>,
): Promise<RuntimeActionResult | undefined> {
  const { message } = input;
  switch (message.kind) {
    // Only task runs report started or reply, and the session hands those to the task kernel.
    case "started":
    case "reply":
      return undefined;
    case "outcome":
      return await handleWorkflowToolRunOutcome({ ...input, message });
    case "request":
      await handleWorkflowToolRunRequest({ ...input, message });
      return undefined;
    case "withdraw":
      await handleWorkflowToolRunWithdraw({ ...input, message });
      return undefined;
    case "report":
      await emitWorkflowToolRunReportStep({
        from: message.from,
        sessionWritable: input.cursor.sessionWritable,
        update: message.update,
      });
      return undefined;
    case "agent-started":
      await input.cursor.apply(
        await emitAgentStartedStep({
          message,
          serializedContext: input.cursor.serializedContext,
          sessionState: input.cursor.sessionState,
          sessionWritable: input.cursor.sessionWritable,
        }),
      );
      return undefined;
  }
}

/**
 * Settles a workflow tool run outcome against the turn's recorded runs and
 * returns the runtime action result the turn should accept, or `undefined`
 * when the outcome does not bind to a run this turn owns.
 */
async function handleWorkflowToolRunOutcome(
  input: HandlerInput<WorkflowToolRunOutcomeMessage>,
): Promise<RuntimeActionResult | undefined> {
  const { cursor, message } = input;
  const recorded = findBlockingWorkflowToolRun(
    cursor.sessionState.snapshot.session.state,
    message.from.callId,
    message.from.turnId,
  );
  if (recorded?.address.runId !== message.from.runId) return undefined;

  const result = workflowToolRunOutcomeToToolResult(message);

  return isInboxToolResultFromRecordedWorkflowToolRun(
    cursor.sessionState.snapshot.session.state,
    result,
  )
    ? result
    : undefined;
}

async function handleWorkflowToolRunRequest(
  input: HandlerInput<WorkflowToolRunRequestMessage>,
): Promise<void> {
  const { cursor, message } = input;
  if (message.request.kind === "authorization-request") {
    const request = message.request;
    await deliverWorkflowAuthorization({ ...message, request }, async () => {
      await cursor.apply(
        await runProxySubagentEventStep({
          hookPayload: request.event,
          sessionWritable: cursor.sessionWritable,
          serializedContext: cursor.serializedContext,
          sessionState: cursor.sessionState,
        }),
      );
    });
    return;
  }
  await cursor.apply(
    await runProxySubagentEventStep({
      ...(message.requestCoordinates === undefined
        ? { answerHook: createAnswerHookRoute(message) }
        : {}),
      hookPayload: workflowToolRunRequestToInputRequestPayload(message),
      sessionWritable: cursor.sessionWritable,
      serializedContext: cursor.serializedContext,
      sessionState: cursor.sessionState,
    }),
  );
}

/** A run withdrew a `ctx.ask()` question: the channel stops offering it. */
async function handleWorkflowToolRunWithdraw(
  input: HandlerInput<WorkflowToolRunWithdrawMessage>,
): Promise<void> {
  const { cursor, message } = input;
  if (!isTrackedSender(cursor.sessionState.snapshot.session.state, message.from)) return;
  await cursor.apply(
    await withdrawWorkflowToolRunQuestionStep({
      requestId: message.replyTo,
      runId: message.from.runId,
      sessionState: cursor.sessionState,
      sessionWritable: cursor.sessionWritable,
    }),
  );
}

/** Whether the session still tracks the run that sent a message: a task's, or one a turn waits on. */
function isTrackedSender(state: SessionStateMap | undefined, from: WorkflowToolRunRef): boolean {
  if (from.taskId !== undefined) {
    return findTask(readTaskTable(state), from.taskId)?.run?.runId === from.runId;
  }
  return findBlockingWorkflowToolRun(state, from.callId, from.turnId)?.address.runId === from.runId;
}

function createAnswerHookRoute(message: WorkflowToolRunRequestMessage): AnswerHookRoute {
  if (message.request.kind !== "ask") return { runId: message.from.runId };
  const { allowFreeform, options } = message.request.request;
  return {
    question: {
      ...(allowFreeform !== undefined && { allowFreeform }),
      ...(options !== undefined && { options: [...options] }),
    },
    runId: message.from.runId,
  };
}
