import { deliverWorkflowRelay } from "#execution/tools/workflow/owner.js";
import type { AppliedRunMessage } from "#execution/tools/workflow/apply-run-messages.js";
import {
  isAgentSessionMessage,
  runMessageBatchBudget,
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
import { isTaskRunMessage } from "#execution/tasks/session.js";
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

export function isAppliedRunMessage(message: WorkflowToolRunMessage): message is AppliedRunMessage {
  return isAgentSessionMessage(message) || message.kind === "report" || isTaskRunMessage(message);
}

export function takeLeadingAppliedRunMessages(
  inbox: SessionInboxReader,
  admits = runMessageBatchBudget(),
): AppliedRunMessage[] {
  return inbox.takeLeading(
    (payload): payload is AppliedRunMessage =>
      isWorkflowMessage(payload) && isAppliedRunMessage(payload) && admits(payload),
  );
}

export async function handleWorkflowToolRunMessage(
  input: HandlerInput<Exclude<WorkflowToolRunMessage, AppliedRunMessage>>,
): Promise<RuntimeActionResult | undefined> {
  const { message } = input;
  switch (message.kind) {
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
  if (message.request.kind === "relay") {
    const relayMessage = {
      from: message.from,
      ...(message.replyTo !== undefined && { replyTo: message.replyTo }),
      request: message.request,
    };
    await deliverWorkflowRelay(relayMessage, async () => {
      await cursor.advance((state) =>
        runProxySubagentEventStep({ hookPayload: relayMessage.request.event, runId, ...state }),
      );
    });
    return;
  }
  const askMessage = {
    from: message.from,
    replyTo: message.replyTo!,
    request: message.request,
  };
  await cursor.advance((state) =>
    runProxySubagentEventStep({
      hookPayload: workflowAskPayload(askMessage),
      runId,
      workflowAsk: createWorkflowAskRoute(askMessage.request),
      ...state,
    }),
  );
}

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
