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
  workflowToolRunRequestToInputRequestPayload,
} from "#execution/tools/workflow/owner-inbox.js";
import { findWorkflowToolRun } from "#harness/workflow-tool-runs.js";
import { runProxySubagentEventStep } from "#subagents/event-proxy-step.js";
import type { RuntimeSubagentResult } from "#shared/action-types.js";

interface HandlerInput<T> {
  readonly callbackMetadataUrl: string;
  readonly cursor: TurnExecutionCursor;
  readonly message: T;
}

export async function handleWorkflowToolRunOutcome(
  input: HandlerInput<WorkflowToolRunOutcomeMessage>,
): Promise<RuntimeSubagentResult | undefined> {
  const { cursor, message } = input;
  const recorded = findWorkflowToolRun(
    cursor.sessionState.snapshot?.session.state,
    message.from.callId,
  );
  if (recorded?.runId !== message.from.runId) return undefined;
  const result = workflowToolRunOutcomeToSubagentResult(message);
  if (message.from.resultKind === "subagent" && result.origin === "child") {
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
  await cancelAgentInvocationOwnerStep({
    ownerId: message.from.runId,
    serializedContext: cursor.serializedContext,
    sessionState: cursor.sessionState,
  });
  const released = await releaseAgentInvocationOwnerStep({
    ownerId: message.from.runId,
    sessionState: cursor.sessionState,
  });
  await cursor.adopt({
    serializedContext: cursor.serializedContext,
    sessionState: released.sessionState,
  });
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
