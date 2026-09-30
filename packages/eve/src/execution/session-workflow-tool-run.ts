import { deliverWorkflowAuthorization } from "#execution/tools/workflow/owner.js";
import {
  emitAgentStartedStep,
  emitWorkflowToolRunReportStep,
} from "#execution/tools/workflow/emit-workflow-tool-run-report-step.js";
import type {
  WorkflowToolAskRequest,
  WorkflowToolRunAgentStartedMessage,
  WorkflowToolRunMessage,
  WorkflowToolRunOutcomeMessage,
  WorkflowToolRunRequestMessage,
  WorkflowToolRunWithdrawMessage,
} from "#execution/tools/workflow/messages.js";
import {
  withdrawFinishedRunQuestionsStep,
  withdrawWorkflowToolRunQuestionStep,
} from "#execution/tools/workflow/withdraw-step.js";
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
import type { WorkflowAskRoute } from "#harness/proxy-input-requests.js";
import type { RuntimeActionResult } from "#shared/action-types.js";

interface HandlerInput<T> {
  readonly cursor: SessionStateCursor;
  readonly message: T;
}

export async function handleWorkflowToolRunMessage(
  input: HandlerInput<WorkflowToolRunMessage>,
): Promise<RuntimeActionResult | undefined> {
  const { message } = input;
  switch (message.kind) {
    // Only task runs report started, reply, or usage, and the session applies those to the task table.
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
    case "report":
      await input.cursor.advance((state) =>
        emitWorkflowToolRunReportStep({ ...state, from: message.from, update: message.update }),
      );
      return undefined;
    case "agent-started":
      await input.cursor.advance((state) =>
        emitAgentStartedStep({ ...state, messages: [message] }),
      );
      return undefined;
  }
}

/** Boundary messages in admission order, with consecutive `agent-started` messages grouped. */
type BoundaryBatch =
  | { readonly kind: "agent-started"; readonly messages: WorkflowToolRunAgentStartedMessage[] }
  | { readonly kind: "message"; readonly message: WorkflowToolRunMessage };

/** Groups consecutive `agent-started` messages so one `emitAgentStartedStep` publishes each group. */
export function batchAgentStarts(messages: readonly WorkflowToolRunMessage[]): BoundaryBatch[] {
  const batches: BoundaryBatch[] = [];
  for (const message of messages) {
    const last = batches.at(-1);
    if (message.kind !== "agent-started") batches.push({ kind: "message", message });
    else if (last?.kind === "agent-started") last.messages.push(message);
    else batches.push({ kind: "agent-started", messages: [message] });
  }
  return batches;
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
  if (message.request.kind === "authorization-request") {
    const request = message.request;
    await deliverWorkflowAuthorization({ ...message, request }, async () => {
      await cursor.advance((state) =>
        runProxySubagentEventStep({ hookPayload: request.event, ...state }),
      );
    });
    return;
  }
  await cursor.advance((state) =>
    runProxySubagentEventStep({
      ...(message.request.kind === "ask" && {
        workflowAsk: createWorkflowAskRoute(message.request),
      }),
      hookPayload: workflowToolRunRequestToInputRequestPayload(message),
      runId: message.from.runId,
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
  const { allowFreeform, options } = ask.request;
  return {
    control: ask.control,
    question: {
      ...(allowFreeform !== undefined && { allowFreeform }),
      ...(options !== undefined && { options: [...options] }),
    },
  };
}
