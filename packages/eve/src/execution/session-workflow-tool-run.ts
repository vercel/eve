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
import type { SessionStepRunner } from "#execution/session/steps.js";
import type { WorkflowAskRoute } from "#harness/hitl/relays.js";
import type { RuntimeActionResult } from "#shared/action-types.js";

interface HandlerInput<T> {
  readonly cursor: SessionStateCursor;
  readonly message: T;
  readonly steps: SessionStepRunner;
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
  const { cursor, message, steps } = input;
  const state = cursor.sessionState.snapshot.session.state;
  const recorded = findBlockingWorkflowToolRun(state, message.from.callId, message.from.turnId);
  if (recorded?.address.runId !== message.from.runId) return undefined;

  const result = workflowToolRunOutcomeToToolResult(message);
  if (!isInboxToolResultFromRecordedWorkflowToolRun(state, result)) return undefined;

  if (cursor.sessionState.hasProxyInputRequests) {
    const { runId } = message.from;
    await cursor.advance((current) =>
      steps.host.step(
        "withdrawFinishedRunQuestions",
        { ...current, runId },
        steps.stepCall("withdrawFinishedRunQuestions"),
      ),
    );
  }
  return result;
}

async function handleWorkflowToolRunRequest(
  input: HandlerInput<WorkflowToolRunRequestMessage>,
): Promise<void> {
  const { cursor, message, steps } = input;
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
    await deliverWorkflowRelay(
      { ...message, request },
      async () => {
        await cursor.advance((state) =>
          steps.host.step(
            "proxySubagentEvent",
            { hookPayload: request.event, runId, ...state },
            steps.stepCall("proxySubagentEvent"),
          ),
        );
      },
      steps,
    );
    return;
  }
  await cursor.advance((state) =>
    steps.host.step(
      "proxySubagentEvent",
      {
        hookPayload: workflowAskPayload({ ...message, request }),
        runId,
        workflowAsk: createWorkflowAskRoute(request),
        ...state,
      },
      steps.stepCall("proxySubagentEvent"),
    ),
  );
}

async function handleWorkflowToolRunWithdraw(
  input: HandlerInput<WorkflowToolRunWithdrawMessage>,
): Promise<void> {
  const { cursor, message, steps } = input;
  await cursor.advance((state) =>
    steps.host.step(
      "withdrawRunQuestion",
      {
        ...state,
        control: message.control,
        requestId: message.replyTo,
        runId: message.from.runId,
      },
      steps.stepCall("withdrawRunQuestion"),
    ),
  );
}

function createWorkflowAskRoute(ask: WorkflowToolAskRequest): WorkflowAskRoute {
  return { control: ask.control };
}
