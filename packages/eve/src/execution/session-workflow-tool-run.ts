import { deliverWorkflowAuthorization } from "#execution/tools/workflow/owner.js";
import { emitWorkflowToolRunReportStep } from "#execution/tools/workflow/emit-workflow-tool-run-report-step.js";
import type {
  WorkflowToolRunMessage,
  WorkflowToolRunOutcomeMessage,
  WorkflowToolRunRequestMessage,
} from "#execution/tools/workflow/messages.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import type { SessionStateCursor } from "#execution/session/state-cursor.js";
import { applyTaskAgentRequest } from "#execution/tools/subagent/task-agent-requests.js";
import { cancelAgentInvocationOwnerStep } from "#execution/tools/subagent/task-cancel.js";
import { AGENT_HANDLES_STATE_KEY } from "#subagents/handles/state-key.js";
import { releaseAgentInvocationOwnerHandles } from "#subagents/handles/query.js";
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
import type { AnswerHookRoute } from "#harness/proxy-input-requests.js";
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
    case "report":
      await emitWorkflowToolRunReportStep({
        from: message.from,
        sessionWritable: input.cursor.sessionWritable,
        update: message.update,
      });
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

  // Keep durable cleanup steps limited to the handles being cancelled.
  const cleanup = releaseAgentInvocationOwnerHandles(cursor.sessionState.snapshot.session.state, {
    cancelled: message.result.status === "cancelled",
    ownerId: message.from.runId,
  });
  if (cleanup.claimedHandles.length > 0) {
    await cancelAgentInvocationOwnerStep({
      ownerId: message.from.runId,
      handles: cleanup.claimedHandles,
      ...(cleanup.claimedHandles.some((handle) => handle.address.kind === "agent/remote")
        ? { serializedContext: cursor.serializedContext }
        : {}),
    });
  }
  if (cleanup.handles !== undefined) {
    const sessionState = cursor.sessionState;
    const session = sessionState.snapshot.session;
    await cursor.apply({
      serializedContext: cursor.serializedContext,
      sessionState: {
        ...sessionState,
        snapshot: {
          ...sessionState.snapshot,
          session: {
            ...session,
            state: {
              ...session.state,
              [AGENT_HANDLES_STATE_KEY]: { handles: cleanup.handles },
            },
          },
        },
      },
    });
  }

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

function createAnswerHookRoute(message: WorkflowToolRunRequestMessage): AnswerHookRoute {
  if (message.request.kind !== "ask") return { runId: message.from.runId };
  const { allowFreeform, dismissible, options } = message.request.request;
  return {
    question: {
      ...(allowFreeform !== undefined && { allowFreeform }),
      ...(dismissible !== undefined && { dismissible }),
      ...(options !== undefined && { options: [...options] }),
    },
    runId: message.from.runId,
  };
}

function requestContext(input: HandlerInput<unknown>) {
  return {
    callbackBaseUrl: resolveWorkflowCallbackBaseUrl(input.callbackMetadataUrl),
    sessionWritable: input.cursor.sessionWritable,
    serializedContext: input.cursor.serializedContext,
    sessionState: input.cursor.sessionState,
  };
}
