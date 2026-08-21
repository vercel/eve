import type { EveAgentReducer, EveAgentReducerEvent } from "#client/reducer.js";
import {
  createAuthorizationCompletedPart,
  createAuthorizationRequiredPart,
} from "#client/authorization-message-parts.js";
import type { EveDynamicToolPart, EveMessageData } from "#client/message-reducer-types.js";
import {
  approvedApproval,
  createToolMetadata,
  mergeToolMetadata,
  normalizeActionRequest,
  normalizeActionResult,
  stringifyUnknown,
  toMessageInputRequest,
} from "#client/message-action-parts.js";
import {
  ensureStepStartPart,
  findLatestPendingAuthorizationPart,
  findToolPart,
  findToolPartByApprovalId,
  optimisticUserMessageId,
  projectReceivedParts,
  removeStreamingToolParts,
  removeTextPart,
  updateAssistantMessage,
  updateAssistantMetadata,
  updateAuthorizationPart,
  updateExistingAssistantMessage,
  updateToolPart,
  upsertMessage,
  upsertPart,
  upsertRun,
} from "#client/message-reducer-state.js";
import type { InputResponse } from "#shared/input.js";
import type { AuthorizationCompletedStreamEvent, InputResolution } from "#protocol/message.js";

export type {
  EveAuthorizationChallenge,
  EveAuthorizationOutcome,
  EveAuthorizationPart,
  EveMessageData,
  EveDynamicToolPart,
  EveMessageInputRequest,
  EveMessage,
  EveMessageMetadata,
  EveMessagePart,
  EveMessageToolMetadata,
} from "#client/message-reducer-types.js";

/**
 * Creates a UIMessage-compatible eve reducer for chat and agent UIs.
 *
 * The returned projection keeps eve-owned types while following the AI SDK
 * `messages[].parts[]` rendering convention used by AI Elements. It projects
 * text, reasoning, tool calls, tool results, tool approvals, submitted HITL
 * responses, and authorization prompts.
 */
export function defaultMessageReducer(): EveAgentReducer<EveMessageData> {
  return {
    initial() {
      return { messages: [] };
    },
    reduce(data, event) {
      return reduceMessageData(data, event);
    },
  };
}

function reduceMessageData(data: EveMessageData, event: EveAgentReducerEvent): EveMessageData {
  switch (event.type) {
    case "client.message.submitted":
      return upsertMessage(data, {
        id: optimisticUserMessageId(event.data.submissionId),
        metadata: {
          optimistic: true,
          status: "submitted",
        },
        parts: [{ type: "text", text: event.data.message }],
        role: "user",
      });

    case "client.message.failed":
      return upsertMessage(data, {
        id: optimisticUserMessageId(event.data.submissionId),
        metadata: {
          optimistic: true,
          status: "failed",
        },
        parts: [{ type: "text", text: event.data.message }],
        role: "user",
      });

    case "client.input.responded": {
      let next = data;
      for (const response of event.data.responses) {
        next = respondToInputRequest(next, response);
      }
      return next;
    }

    case "input.resolved": {
      let next = data;
      for (const resolution of event.data.resolutions) {
        next = resolveInputRequest(next, resolution);
      }
      return next;
    }

    case "message.received":
      return upsertMessage(data, {
        id: `${event.data.turnId}:user`,
        metadata: {
          status: "complete",
          turnId: event.data.turnId,
        },
        parts: projectReceivedParts(event.data.parts, event.data.message),
        role: "user",
      });

    case "step.started":
      return updateAssistantMessage(data, event.data.turnId, (message) =>
        ensureStepStartPart(message, event.data.stepIndex),
      );

    case "reasoning.appended":
      return updateAssistantMessage(data, event.data.turnId, (message) =>
        upsertRun(ensureStepStartPart(message, event.data.stepIndex), {
          state: "streaming",
          stepIndex: event.data.stepIndex,
          text: event.data.reasoningSoFar,
          type: "reasoning",
        }),
      );

    case "reasoning.completed":
      return updateAssistantMessage(data, event.data.turnId, (message) =>
        upsertRun(ensureStepStartPart(message, event.data.stepIndex), {
          state: "done",
          stepIndex: event.data.stepIndex,
          text: event.data.reasoning,
          type: "reasoning",
        }),
      );

    case "action.input.appended": {
      const existing = findToolPart(data, event.data.callId);
      if (existing !== undefined && existing.state !== "input-streaming") {
        return data;
      }

      const nextPart: EveDynamicToolPart = {
        input: undefined,
        inputText: event.data.inputTextSoFar,
        state: "input-streaming",
        stepIndex: event.data.stepIndex,
        toolCallId: event.data.callId,
        toolMetadata: existing?.toolMetadata ?? {
          eve: {
            kind: "unknown",
            name: event.data.toolName,
          },
        },
        toolName: event.data.toolName,
        type: "dynamic-tool",
      };

      if (existing !== undefined) {
        return updateToolPart(data, event.data.callId, nextPart);
      }

      return updateAssistantMessage(data, event.data.turnId, (message) =>
        upsertPart(ensureStepStartPart(message, event.data.stepIndex), nextPart),
      );
    }

    case "actions.requested": {
      let next = data;
      for (const action of event.data.actions) {
        const descriptor = normalizeActionRequest(action);
        next = updateAssistantMessage(next, event.data.turnId, (message) =>
          upsertPart(ensureStepStartPart(message, event.data.stepIndex), {
            input: "input" in action ? action.input : undefined,
            state: "input-available",
            stepIndex: event.data.stepIndex,
            toolCallId: action.callId,
            toolMetadata: createToolMetadata(descriptor),
            toolName: descriptor.toolName,
            type: "dynamic-tool",
          }),
        );
      }
      return next;
    }

    case "input.requested": {
      let next = data;
      for (const request of event.data.requests) {
        const descriptor = normalizeActionRequest(request.action);
        next = updateAssistantMessage(next, event.data.turnId, (message) =>
          upsertPart(ensureStepStartPart(message, event.data.stepIndex), {
            approval: {
              id: request.requestId,
            },
            input: request.action.input,
            state: "approval-requested",
            stepIndex: event.data.stepIndex,
            toolCallId: request.action.callId,
            toolMetadata: createToolMetadata(descriptor, {
              inputRequest: toMessageInputRequest(request),
            }),
            toolName: descriptor.toolName,
            type: "dynamic-tool",
          }),
        );
      }
      return next;
    }

    case "approval.candidate":
      // Candidate progress is responder-specific. Applications can consume the
      // raw stream event for private UI without changing the shared tool part.
      return data;

    case "approval.settled": {
      const existing = findToolPartByApprovalId(data, event.data.requestId);
      if (existing === undefined) return data;
      if (event.data.outcome === "approved") {
        return updateToolPart(data, existing.toolCallId, {
          approval: { approved: true, id: event.data.requestId, reason: undefined },
          input: existing.input,
          state: "approval-responded",
          stepIndex: existing.stepIndex,
          toolCallId: existing.toolCallId,
          toolMetadata: existing.toolMetadata,
          toolName: existing.toolName,
          type: "dynamic-tool",
        });
      }
      return updateToolPart(data, existing.toolCallId, {
        approval: {
          approved: false,
          id: event.data.requestId,
          reason: "Tool execution was cancelled.",
        },
        input: existing.input,
        state: "output-denied",
        stepIndex: existing.stepIndex,
        toolCallId: existing.toolCallId,
        toolMetadata: existing.toolMetadata,
        toolName: existing.toolName,
        type: "dynamic-tool",
      });
    }

    case "action.result": {
      const descriptor = normalizeActionResult(event.data.result);
      const existing = findToolPart(data, event.data.result.callId);
      const denied = event.data.error?.code === "TOOL_EXECUTION_DENIED";
      const failed = event.data.status === "failed" && !denied;
      const approvalId = existing?.approval?.id ?? event.data.result.callId;
      const toolMetadata = mergeToolMetadata(
        existing?.toolMetadata,
        createToolMetadata(descriptor),
      );
      const resultPartBase = {
        input: existing?.input,
        stepIndex: event.data.stepIndex,
        toolCallId: event.data.result.callId,
        toolMetadata,
        toolName: existing?.toolName ?? descriptor.toolName,
        type: "dynamic-tool" as const,
      };

      let nextPart: EveDynamicToolPart;
      if (denied) {
        nextPart = {
          ...resultPartBase,
          approval: {
            approved: false,
            id: approvalId,
            reason: event.data.error?.message,
          },
          state: "output-denied",
        };
      } else if (failed) {
        nextPart = {
          ...resultPartBase,
          approval: approvedApproval(existing),
          errorText: event.data.error?.message ?? stringifyUnknown(event.data.result.output),
          state: "output-error",
        };
      } else {
        nextPart = {
          ...resultPartBase,
          approval: approvedApproval(existing),
          output: event.data.result.output,
          state: "output-available",
        };
      }

      if (existing !== undefined) {
        // Approved tool results can arrive on a later runtime turn; keep
        // the UI lifecycle anchored to the original tool call.
        return updateToolPart(data, event.data.result.callId, nextPart);
      }

      return updateAssistantMessage(data, event.data.turnId, (message) =>
        upsertPart(ensureStepStartPart(message, event.data.stepIndex), nextPart),
      );
    }

    case "action.partial": {
      const existing = findToolPart(data, event.data.result.callId);
      if (existing !== undefined && isSettledToolPart(existing)) {
        return data;
      }

      const descriptor = normalizeActionResult(event.data.result);
      const nextPart: EveDynamicToolPart = {
        approval: approvedApproval(existing),
        input: existing?.input,
        output: event.data.result.output,
        partial: true,
        state: "output-available",
        stepIndex: event.data.stepIndex,
        toolCallId: event.data.result.callId,
        toolMetadata: mergeToolMetadata(existing?.toolMetadata, createToolMetadata(descriptor)),
        toolName: existing?.toolName ?? descriptor.toolName,
        type: "dynamic-tool",
      };

      if (existing !== undefined) {
        return updateToolPart(data, event.data.result.callId, nextPart);
      }

      return updateAssistantMessage(data, event.data.turnId, (message) =>
        upsertPart(ensureStepStartPart(message, event.data.stepIndex), nextPart),
      );
    }

    case "authorization.required":
      return updateAssistantMessage(data, event.data.turnId, (message) =>
        upsertPart(
          ensureStepStartPart(message, event.data.stepIndex),
          createAuthorizationRequiredPart(event),
        ),
      );

    case "authorization.completed":
      return completeAuthorization(data, event);

    case "message.appended":
      return updateAssistantMessage(data, event.data.turnId, (message) =>
        upsertRun(ensureStepStartPart(message, event.data.stepIndex), {
          state: "streaming",
          stepIndex: event.data.stepIndex,
          text: event.data.messageSoFar,
          type: "text",
        }),
      );

    case "message.completed":
      return updateAssistantMessage(data, event.data.turnId, (message) => {
        if (event.data.message === null) {
          return removeTextPart(message, event.data.stepIndex);
        }

        return upsertRun(ensureStepStartPart(message, event.data.stepIndex), {
          state: "done",
          stepIndex: event.data.stepIndex,
          text: event.data.message,
          type: "text",
        });
      });

    case "result.completed":
      return updateAssistantMetadata(data, event.data.turnId, { result: event.data.result });

    case "turn.completed":
      return updateAssistantMessage(data, event.data.turnId, (message) => ({
        ...message,
        metadata: { ...message.metadata, status: "complete" },
        parts: removeStreamingToolParts(message.parts),
      }));

    case "turn.cancelled":
      // Finalize whatever the cancelled turn streamed: no message.completed
      // or reasoning.completed will follow a partial append.
      return updateAssistantMessage(data, event.data.turnId, (message) => ({
        ...message,
        metadata: { ...message.metadata, status: "complete" },
        parts: removeStreamingToolParts(
          message.parts.map((part) =>
            (part.type === "text" || part.type === "reasoning") && part.state === "streaming"
              ? { ...part, state: "done" }
              : part,
          ),
        ),
      }));

    case "turn.failed":
      return updateExistingAssistantMessage(data, event.data.turnId, (message) => {
        const parts = removeStreamingToolParts(message.parts);
        return parts === message.parts ? message : { ...message, parts };
      });

    case "session.failed":
      return data;

    default:
      return data;
  }
}

function respondToInputRequest(data: EveMessageData, response: InputResponse): EveMessageData {
  const existing = findToolPartByApprovalId(data, response.requestId);
  if (!existing) return data;

  const approval: { id: string; reason?: string } = {
    id: response.requestId,
  };
  if (response.text !== undefined) {
    approval.reason = response.text;
  }

  return updateToolPart(data, existing.toolCallId, {
    approval,
    input: existing.input,
    state: "approval-responded",
    stepIndex: existing.stepIndex,
    toolCallId: existing.toolCallId,
    toolMetadata: mergeToolMetadata(existing.toolMetadata, {
      eve: {
        inputResponse: response,
        kind: existing.toolMetadata?.eve?.kind ?? "unknown",
        name: existing.toolMetadata?.eve?.name ?? existing.toolName,
      },
    }),
    toolName: existing.toolName,
    type: "dynamic-tool",
  });
}

function resolveInputRequest(data: EveMessageData, resolution: InputResolution): EveMessageData {
  if (resolution.response !== undefined) {
    return respondToInputRequest(data, resolution.response);
  }

  const existing = findToolPartByApprovalId(data, resolution.requestId);
  if (!existing) return data;

  return updateToolPart(data, existing.toolCallId, {
    input: existing.input,
    output: { status: resolution.outcome },
    state: "output-available",
    stepIndex: existing.stepIndex,
    toolCallId: existing.toolCallId,
    toolMetadata: existing.toolMetadata,
    toolName: existing.toolName,
    type: "dynamic-tool",
  });
}

function completeAuthorization(
  data: EveMessageData,
  event: AuthorizationCompletedStreamEvent,
): EveMessageData {
  const existing = findLatestPendingAuthorizationPart(data, event.data.name);
  const next = createAuthorizationCompletedPart(event, existing);

  if (existing !== undefined) {
    return updateAuthorizationPart(data, existing, next);
  }

  return updateAssistantMessage(data, event.data.turnId, (message) =>
    upsertPart(ensureStepStartPart(message, event.data.stepIndex), next),
  );
}

function isSettledToolPart(part: EveDynamicToolPart): boolean {
  return (
    part.state === "output-denied" ||
    part.state === "output-error" ||
    (part.state === "output-available" && part.partial !== true)
  );
}
