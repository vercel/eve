import { deliverWorkflowAuthorization } from "#execution/tools/workflow/owner.js";
import {
  emitAgentStartedStep,
  emitWorkflowToolRunReportStep,
} from "#execution/tools/workflow/emit-workflow-tool-run-report-step.js";
import type {
  WorkflowToolAskRequest,
  WorkflowToolRunMessage,
  WorkflowToolRunOutcomeMessage,
  WorkflowToolRunRef,
  WorkflowToolRunRequestMessage,
  WorkflowToolRunWithdrawMessage,
} from "#execution/tools/workflow/messages.js";
import { withdrawWorkflowToolRunQuestionStep } from "#execution/tools/workflow/withdraw-step.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import type { SessionStateCursor } from "#execution/session/state-cursor.js";
import { applyTaskAgentRequest } from "#execution/tools/subagent/task-agent-requests.js";
import { cancelAgentInvocationOwnerStep } from "#execution/tools/subagent/task-cancel.js";
import { releaseAgentInvocationOwnerStep } from "#execution/tools/subagent/invoke-step.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
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
  readonly callbackMetadataUrl: string;
  readonly cursor: SessionStateCursor;
  readonly message: T;
}

export async function handleWorkflowToolRunMessage(
  input: HandlerInput<WorkflowToolRunMessage>,
): Promise<RuntimeActionResult | undefined> {
  const { message } = input;
  switch (message.kind) {
    case "outcome":
      return await handleWorkflowToolRunOutcome({ ...input, message });
    case "request":
      await handleWorkflowToolRunRequest({ ...input, message });
      return undefined;
    case "withdraw":
      await handleWorkflowToolRunWithdraw({ ...input, message });
      return undefined;
    case "report":
      await input.cursor.apply(
        await emitWorkflowToolRunReportStep({
          ...input.cursor.stepState(),
          from: message.from,
          update: message.update,
        }),
      );
      return undefined;
    case "agent-started":
      await input.cursor.apply(
        await emitAgentStartedStep({ ...input.cursor.stepState(), message }),
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

  // A failed or cancelled workflow may leave an agent invocation unfinished.
  await cancelAgentInvocationOwnerStep({
    ownerId: message.from.runId,
    serializedContext: cursor.serializedContext,
    sessionState: cursor.sessionState,
  });
  const released = await releaseAgentInvocationOwnerStep({
    cancelled: message.result.status === "cancelled",
    ownerId: message.from.runId,
    sessionState: cursor.sessionState,
  });
  await cursor.apply({
    serializedContext: cursor.serializedContext,
    sessionState: released.sessionState,
  });

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
  if (message.request.kind === "agent-invoke" || message.request.kind === "agent-settled") {
    const recorded = findBlockingWorkflowToolRun(
      cursor.sessionState.snapshot.session.state,
      message.from.callId,
      message.from.turnId,
    );
    if (recorded?.address.runId !== message.from.runId) {
      if (message.request.kind === "agent-invoke") {
        await resumeHookStep(message.replyTo, {
          kind: "runtime-action-result",
          results: [
            {
              callId: message.request.invocationId,
              isError: true,
              kind: "subagent-result",
              origin: "dispatch",
              output: {
                code: "AGENT_INVOCATION_NOT_ADMITTED",
                message: "The workflow tool run no longer owns this agent invocation.",
              },
              subagentName: message.request.input.target,
            },
          ],
        });
      }
      return;
    }
    await cursor.apply(
      await applyTaskAgentRequest(
        {
          ownerId: message.from.runId,
          replyTo: message.replyTo,
          request: message.request,
        },
        requestContext(input),
      ),
    );
    return;
  }
  if (message.request.kind === "authorization-request") {
    const request = message.request;
    await deliverWorkflowAuthorization({ ...message, request }, async () => {
      await cursor.apply(
        await runProxySubagentEventStep({
          hookPayload: request.event,
          ...cursor.stepState(),
        }),
      );
    });
    return;
  }
  await cursor.apply(
    await runProxySubagentEventStep({
      ...(message.request.kind === "ask" && {
        workflowAsk: createWorkflowAskRoute(message.from, message.request),
      }),
      hookPayload: workflowToolRunRequestToInputRequestPayload(message),
      ...cursor.stepState(),
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
  await cursor.apply(
    await withdrawWorkflowToolRunQuestionStep({
      ...cursor.stepState(),
      control: message.control,
      requestId: message.replyTo,
      runId: message.from.runId,
    }),
  );
}

function createWorkflowAskRoute(
  from: WorkflowToolRunRef,
  ask: WorkflowToolAskRequest,
): WorkflowAskRoute {
  const { allowFreeform, options } = ask.request;
  return {
    control: ask.control,
    question: {
      ...(allowFreeform !== undefined && { allowFreeform }),
      ...(options !== undefined && { options: [...options] }),
    },
    runId: from.runId,
  };
}

function requestContext(input: HandlerInput<unknown>) {
  return {
    callbackBaseUrl: resolveWorkflowCallbackBaseUrl(input.callbackMetadataUrl),
    ...input.cursor.stepState(),
  };
}
