import type { HookPayload } from "#channel/types.js";
import {
  findRunningAgentHandle,
  isInboxSubagentResultFromRunningHandle,
} from "#subagents/handles/query.js";
import type { DurableSessionState } from "#execution/session/state.js";
import type { InboxAddress, InboxEnvelope } from "#execution/inbox/types.js";
import { sendInbox } from "#execution/inbox/send.js";
import { applyTaskAgentRequest } from "#execution/tools/subagent/task-agent-requests.js";
import { cancelAgentInvocationOwner } from "#execution/tools/subagent/task-cancel.js";
import { releaseAgentInvocationOwner } from "#execution/tools/subagent/invoke.js";
import { emitTurnEvent } from "#execution/turn/events.js";
import { createActionPartialEvent } from "#protocol/message.js";
import { createRuntimeToolResultFromValue } from "#harness/action-result-helpers.js";
import type {
  WorkflowToolRunOutcomeMessage,
  WorkflowToolRunReport,
  WorkflowToolRunRequestMessage,
} from "#execution/workflow-tool/messages.js";
import {
  workflowToolRunOutcomeToSubagentResult,
  workflowToolRunOutcomeToToolResult,
  workflowToolRunRequestToInputRequestPayload,
} from "#execution/workflow-tool/results.js";
import {
  findWorkflowToolRun,
  isInboxToolResultFromRecordedWorkflowToolRun,
  isInboxSubagentResultFromRecordedWorkflowToolRun,
} from "#harness/workflow-tool-runs.js";
import { runProxySubagentEvent } from "#subagents/event-proxy.js";
import type { RuntimeActionResult } from "#shared/action-types.js";

/** Applies execution traffic to hydrated state inside the turn's existing step. */
export async function applyRuntimeEvents(input: {
  readonly events: readonly InboxEnvelope[];
  readonly state: DurableSessionState;
  readonly serializedContext: Record<string, unknown>;
  readonly eventsWriter: WritableStream<Uint8Array>;
  readonly owner: InboxAddress;
}): Promise<{
  readonly state: DurableSessionState;
  readonly serializedContext: Record<string, unknown>;
  readonly results: RuntimeActionResult[];
  readonly acceptedAtMsByCallId: Readonly<Record<string, number>>;
}> {
  let state = input.state;
  let serializedContext = input.serializedContext;
  const results: RuntimeActionResult[] = [];
  const acceptedAtMsByCallId: Record<string, number> = {};
  for (const envelope of input.events) {
    if (envelope.target !== undefined && envelope.target.ownerRunId !== input.owner.ownerRunId)
      continue;
    if (envelope.kind === "runtime.result") {
      const payload = envelope.payload as HookPayload;
      if (payload.kind === "runtime-action-result") {
        const snapshot = state.snapshot.session.state;
        const accepted = payload.results.filter((result) =>
          result.kind === "tool-result"
            ? isInboxToolResultFromRecordedWorkflowToolRun(snapshot, result)
            : result.kind === "subagent-result" &&
              ((result.origin === "child" &&
                isInboxSubagentResultFromRunningHandle(snapshot, result)) ||
                isInboxSubagentResultFromRecordedWorkflowToolRun(snapshot, result)),
        );
        for (const result of accepted) {
          if (results.some((existing) => existing.callId === result.callId)) continue;
          results.push(result);
          acceptedAtMsByCallId[result.callId] = Date.now();
        }
      } else if (
        payload.kind === "subagent-input-request" ||
        payload.kind === "subagent-authorization-event"
      ) {
        const handle = findRunningAgentHandle(state.snapshot.session.state, {
          callId: payload.callId,
        });
        if (
          handle?.identity.name !== payload.subagentName ||
          handle.address.sessionId !== payload.childSessionId
        )
          continue;
        const applied = await runProxySubagentEvent({
          hookPayload: payload,
          parentWritable: input.eventsWriter,
          serializedContext,
          sessionState: state,
        });
        state = applied.sessionState;
        serializedContext = applied.serializedContext;
      }
      continue;
    }
    if (
      envelope.kind !== "tool.report" &&
      envelope.kind !== "tool.request" &&
      envelope.kind !== "tool.outcome"
    )
      continue;
    const message = envelope.payload as
      | WorkflowToolRunReport
      | WorkflowToolRunRequestMessage
      | WorkflowToolRunOutcomeMessage;
    const recorded = findWorkflowToolRun(state.snapshot.session.state, message.from.callId);
    const owned =
      recorded?.runId === message.from.runId && recorded.toolName === message.from.toolName;
    if (!owned) {
      if (envelope.kind === "tool.request")
        await rejectInvocation(message as WorkflowToolRunRequestMessage);
      continue;
    }
    if (envelope.kind === "tool.report") {
      const report = message as WorkflowToolRunReport;
      const applied = await emitTurnEvent({
        event: createActionPartialEvent({
          result: createRuntimeToolResultFromValue({
            callId: report.from.callId,
            output: report.update,
            toolName: report.from.toolName,
          }),
          sequence: report.from.sequence,
          stepIndex: report.from.stepIndex,
          turnId: report.from.turnId,
        }),
        events: input.eventsWriter,
        serializedContext,
        sessionState: state,
      });
      state = applied.sessionState;
      serializedContext = applied.serializedContext;
      continue;
    }
    if (envelope.kind === "tool.request") {
      const request = message as WorkflowToolRunRequestMessage;
      if (request.request.kind === "agent-invoke" || request.request.kind === "agent-settled") {
        const applied = await applyTaskAgentRequest(
          {
            accumulateUsage: request.from.resultKind !== "subagent",
            ownerId: request.from.runId,
            replyTo: request.replyTo,
            request: request.request,
          },
          context(),
        );
        state = applied.sessionState;
        serializedContext = applied.serializedContext;
      } else {
        const applied = await runProxySubagentEvent({
          inboxResponse: request.replyTo.kind === "inbox" ? request.replyTo : undefined,
          hookPayload:
            request.request.kind === "authorization-request"
              ? request.request.event
              : workflowToolRunRequestToInputRequestPayload(request),
          parentWritable: input.eventsWriter,
          serializedContext,
          sessionState: state,
        });
        state = applied.sessionState;
        serializedContext = applied.serializedContext;
      }
      continue;
    }
    const outcome = message as WorkflowToolRunOutcomeMessage;
    const result =
      recorded.resultKind === "subagent"
        ? workflowToolRunOutcomeToSubagentResult(outcome)
        : workflowToolRunOutcomeToToolResult(outcome);
    if (
      result.callId !== message.from.callId ||
      results.some((accepted) => accepted.callId === result.callId)
    )
      continue;
    if (
      result.kind === "subagent-result" &&
      !isInboxSubagentResultFromRecordedWorkflowToolRun(state.snapshot.session.state, result)
    )
      continue;
    if (result.kind === "subagent-result" && result.origin === "child") {
      const applied = await applyTaskAgentRequest(
        {
          accumulateUsage: false,
          ownerId: message.from.runId,
          replyTo: { kind: "inbox", address: input.owner, requestId: envelope.eventId },
          request: { kind: "agent-settled", result },
        },
        context(),
      );
      state = applied.sessionState;
      serializedContext = applied.serializedContext;
    }
    await cancelAgentInvocationOwner({
      ownerId: message.from.runId,
      serializedContext,
      sessionState: state,
    });
    const released = await releaseAgentInvocationOwner({
      cancelled: outcome.result.status === "cancelled",
      ownerId: message.from.runId,
      sessionState: state,
    });
    state = released.sessionState;
    results.push(result);
    acceptedAtMsByCallId[result.callId] = Date.now();
  }
  return { acceptedAtMsByCallId, results, serializedContext, state };

  function context() {
    return { parentWritable: input.eventsWriter, serializedContext, sessionState: state };
  }
}

async function rejectInvocation(message: WorkflowToolRunRequestMessage): Promise<void> {
  if (message.request.kind !== "agent-invoke" || message.replyTo.kind !== "inbox") return;
  await sendInbox(message.replyTo.address, {
    eventId: `${message.replyTo.requestId}:not-admitted`,
    kind: "agent.response",
    payload: {
      kind: "runtime-action-result",
      results: [
        {
          callId: message.request.invocationId,
          isError: true,
          kind: "subagent-result",
          origin: "dispatch",
          output: {
            code: "AGENT_INVOCATION_NOT_ADMITTED",
            message: "The workflow tool no longer owns this invocation.",
          },
          subagentName: message.request.input.target,
        },
      ],
    },
    requestId: message.replyTo.requestId,
  });
}
