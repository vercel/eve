import { deliverWorkflowRelay } from "#execution/tools/workflow/owner.js";
import type { AppliedRunMessage } from "#execution/tools/workflow/apply-run-messages-step.js";
import {
  runMessageBatchBudget,
  isAppliedRunMessage,
  type WorkflowToolAskRequest,
  type WorkflowToolRunMessage,
  type WorkflowToolRunOutcomeMessage,
  type WorkflowToolRunRequestMessage,
  type WorkflowToolRunWithdrawMessage,
} from "#execution/tools/workflow/messages.js";
import {
  withdrawFinishedRunQuestionsStep,
  withdrawWorkflowToolRunQuestionStep,
} from "#execution/tools/workflow/withdraw-step.js";
import type { SessionStateCursor } from "#execution/session/state-cursor.js";
import { isWorkflowMessage, type SessionInboxReader } from "#execution/session-inbox/inbox.js";
import { isActiveTaskRun, readTaskTable } from "#execution/tasks/table.js";
import { storedProjection } from "#harness/session-machine/view.js";
import {
  workflowToolRunOutcomeToToolResult,
  workflowAskPayload,
} from "#execution/tools/workflow/owner-inbox.js";
import {
  findBlockingWorkflowToolRun,
  isInboxToolResultFromRecordedWorkflowToolRun,
} from "#harness/workflow-tool-runs.js";
import { runProxySubagentEventStep } from "#subagents/event-proxy-step.js";
import type { WorkflowAskRoute } from "#harness/hitl/relays.js";
import type { RuntimeActionResult } from "#shared/action-types.js";

interface HandlerInput<T> {
  readonly cursor: SessionStateCursor;
  readonly message: T;
}

export { isAppliedRunMessage } from "#execution/tools/workflow/messages.js";

/**
 * Removes the applied run messages at the front of the inbox, in arrival
 * order, while `admits` takes them. One batch's caller passes its budget on.
 */
export function takeLeadingAppliedRunMessages(
  inbox: SessionInboxReader,
  admits = runMessageBatchBudget(),
): AppliedRunMessage[] {
  return inbox.takeLeading(
    (payload): payload is AppliedRunMessage =>
      isWorkflowMessage(payload) && isAppliedRunMessage(payload) && admits(payload),
  );
}

/**
 * Handles a run message the session does not apply as it reads it: a
 * question, its withdrawal, or an `execute` run's outcome.
 */
export async function handleWorkflowToolRunMessage(
  input: HandlerInput<Exclude<WorkflowToolRunMessage, AppliedRunMessage>>,
): Promise<RuntimeActionResult | undefined> {
  const { message } = input;
  switch (message.kind) {
    // Only task runs report started, reply, or usage, and the session applies those as it reads them.
    case "started":
    case "reply":
    case "usage":
      return undefined;
    case "outcome":
      return await handleWorkflowToolRunOutcome({ ...input, message });
    case "request":
      await handleWorkflowToolRunRequest({ ...input, message });
      return undefined;
    case "withdraw":
      await handleWorkflowToolRunWithdraw({ ...input, message });
      return undefined;
  }
}

/**
 * Settles a workflow tool run outcome against the turn's recorded runs and
 * returns the runtime action result the turn should accept, or `undefined`
 * when the outcome does not bind to a run this turn owns. Requests the run
 * relayed are withdrawn first, since nobody can answer them anymore.
 */
async function handleWorkflowToolRunOutcome(
  input: HandlerInput<WorkflowToolRunOutcomeMessage>,
): Promise<RuntimeActionResult | undefined> {
  const { cursor, message } = input;
  const state = cursor.sessionState.snapshot.session.state;
  const recorded = findBlockingWorkflowToolRun(state, message.from.callId, message.from.turnId);
  if (recorded?.address.runId !== message.from.runId) return undefined;

  const result = workflowToolRunOutcomeToToolResult(message);
  if (!isInboxToolResultFromRecordedWorkflowToolRun(state, result)) return undefined;

  if (cursor.sessionState.hasProxyInputRequests) {
    const { runId } = message.from;
    await cursor.advance((current) => withdrawFinishedRunQuestionsStep({ ...current, runId }));
  }
  return result;
}

async function handleWorkflowToolRunRequest(
  input: HandlerInput<WorkflowToolRunRequestMessage>,
): Promise<void> {
  const { cursor, message } = input;
  const { runId, taskId } = message.from;
  const state = cursor.sessionState.snapshot.session.state;
  if (
    taskId !== undefined &&
    (!isActiveTaskRun(readTaskTable(state), taskId, runId) ||
      storedProjection(state).view?.tasks[taskId]?.status === "ended")
  )
    return;
  const { request } = message;
  if (request.kind === "relay") {
    await deliverWorkflowRelay({ ...message, request }, async () => {
      await cursor.advance((state) =>
        runProxySubagentEventStep({ hookPayload: request.event, runId, ...state }),
      );
    });
    return;
  }
  await cursor.advance((state) =>
    runProxySubagentEventStep({
      hookPayload: workflowAskPayload({ ...message, request }),
      runId,
      workflowAsk: createWorkflowAskRoute(request),
      ...state,
    }),
  );
}

/**
 * A run asks to withdraw a `ctx.ask()` question. The session decides: it
 * withdraws the question unless it already accepted an answer or stopped
 * offering it, and tells the run either way.
 */
async function handleWorkflowToolRunWithdraw(
  input: HandlerInput<WorkflowToolRunWithdrawMessage>,
): Promise<void> {
  const { cursor, message } = input;
  await cursor.advance((state) =>
    withdrawWorkflowToolRunQuestionStep({
      ...state,
      control: message.control,
      requestId: message.replyTo,
      runId: message.from.runId,
    }),
  );
}

function createWorkflowAskRoute(ask: WorkflowToolAskRequest): WorkflowAskRoute {
  return { control: ask.control };
}
