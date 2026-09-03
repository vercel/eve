import type {
  WorkflowToolRunOutcomeMessage,
  WorkflowToolRunRequestMessage,
} from "#execution/tools/workflow/messages.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import type { TurnExecutionCursor } from "#execution/turn-execution-cursor.js";
import { applyTaskAgentRequest } from "#execution/tools/subagent/task-agent-requests.js";
import { cancelAgentInvocationOwnerStep } from "#execution/tools/subagent/task-cancel.js";
import { releaseAgentInvocationOwnerStep } from "#execution/tools/subagent/invoke-step.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import {
  workflowToolRunOutcomeToSubagentResult,
  workflowToolRunOutcomeToToolResult,
  workflowToolRunRequestToInputRequestPayload,
} from "#execution/tools/workflow/owner-inbox.js";
import {
  findWorkflowToolRun,
  isInboxSubagentResultFromRecordedWorkflowToolRun,
  isInboxToolResultFromRecordedWorkflowToolRun,
} from "#harness/workflow-tool-runs.js";
import { runProxySubagentEventStep } from "#subagents/event-proxy-step.js";
import type {
  RuntimeActionResult,
  RuntimeSubagentResult,
  RuntimeToolResultActionResult,
} from "#shared/action-types.js";

interface HandlerInput<T> {
  readonly callbackMetadataUrl: string;
  readonly cursor: TurnExecutionCursor;
  readonly message: T;
}

/**
 * Settles a workflow tool run outcome against the turn's recorded runs and
 * returns the runtime action result the turn should accept, or `undefined`
 * when the outcome does not bind to a run this turn owns.
 */
export async function handleWorkflowToolRunOutcome(
  input: HandlerInput<WorkflowToolRunOutcomeMessage>,
): Promise<RuntimeActionResult | undefined> {
  const { cursor, message } = input;
  const recorded = findWorkflowToolRun(
    cursor.sessionState.snapshot?.session.state,
    message.from.callId,
  );
  if (recorded?.runId !== message.from.runId) return undefined;

  const result: RuntimeSubagentResult | RuntimeToolResultActionResult =
    recorded.resultKind === "subagent"
      ? await settleSubagentOutcome(input)
      : workflowToolRunOutcomeToToolResult(message);

  // Any workflow tool run may have invoked agents through its request channel,
  // so leases are released regardless of the run's result kind.
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
  await cursor.adopt({
    serializedContext: cursor.serializedContext,
    sessionState: released.sessionState,
  });

  const sessionSnapshotState = cursor.sessionState.snapshot?.session.state;
  const accepted =
    result.kind === "subagent-result"
      ? result.callId === message.from.callId &&
        isInboxSubagentResultFromRecordedWorkflowToolRun(sessionSnapshotState, result)
      : isInboxToolResultFromRecordedWorkflowToolRun(sessionSnapshotState, result);
  return accepted ? result : undefined;
}

async function settleSubagentOutcome(
  input: HandlerInput<WorkflowToolRunOutcomeMessage>,
): Promise<RuntimeSubagentResult> {
  const { cursor, message } = input;
  const result = workflowToolRunOutcomeToSubagentResult(message);
  if (result.origin === "child") {
    await cursor.adopt(
      await applyTaskAgentRequest(
        {
          accumulateUsage: false,
          ownerId: message.from.runId,
          replyTo: message.from.runId,
          request: { kind: "agent-settled", result },
        },
        requestContext(input),
      ),
    );
  }
  return result;
}

export async function handleWorkflowToolRunRequest(
  input: HandlerInput<WorkflowToolRunRequestMessage>,
): Promise<void> {
  const { cursor, message } = input;
  if (message.request.kind === "agent-invoke" || message.request.kind === "agent-settled") {
    const recorded = findWorkflowToolRun(
      cursor.sessionState.snapshot?.session.state,
      message.from.callId,
    );
    if (recorded?.runId !== message.from.runId) {
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
    await cursor.adopt(
      await applyTaskAgentRequest(
        {
          actionCallId:
            message.request.kind === "agent-invoke"
              ? (message.request.instrumentationCallId ?? message.from.callId)
              : message.from.callId,
          accumulateUsage: message.from.resultKind !== "subagent",
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
    await cursor.adopt(
      await runProxySubagentEventStep({
        hookPayload: message.request.event,
        parentWritable: cursor.parentWritable,
        serializedContext: cursor.serializedContext,
        sessionState: cursor.sessionState,
      }),
    );
    return;
  }
  await cursor.adopt(
    await runProxySubagentEventStep({
      ...(message.requestCoordinates === undefined
        ? { answerHook: { runId: message.from.runId } }
        : {}),
      hookPayload: workflowToolRunRequestToInputRequestPayload(message),
      parentWritable: cursor.parentWritable,
      serializedContext: cursor.serializedContext,
      sessionState: cursor.sessionState,
    }),
  );
}

function requestContext(input: HandlerInput<unknown>) {
  return {
    callbackBaseUrl: resolveWorkflowCallbackBaseUrl(input.callbackMetadataUrl),
    parentWritable: input.cursor.parentWritable,
    serializedContext: input.cursor.serializedContext,
    sessionState: input.cursor.sessionState,
  };
}
