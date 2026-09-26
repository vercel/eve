import type { EveAgentReducer, EveAgentReducerEvent } from "#client/reducer.js";
import {
  createAuthorizationCompletedPart,
  createAuthorizationRequiredPart,
} from "#client/authorization-message-parts.js";
import type {
  EveAuthorizationPart,
  EveMessageData,
  EveDynamicToolPart,
  EveMessage,
  EveMessagePart,
} from "#client/message-reducer-types.js";
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
  optimisticUserMessageId,
  partKey,
  projectReceivedParts,
  upsertMessage,
} from "#client/message-reducer-primitives.js";
import { messageRun } from "#client/message-run-parts.js";

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

type EveAssistantMessage = EveMessage & { readonly role: "assistant" };
type MessageReceivedEvent = Extract<EveAgentReducerEvent, { readonly type: "message.received" }>;

function receivedMessageEventId(event: MessageReceivedEvent): string {
  const eventId: string | undefined = event.meta.id;
  return eventId ?? `${event.data.turnId}:${event.data.sequence}`;
}

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
    case "client.child.observed":
    case "client.child.following":
    case "client.child.settled":
      return data;

    case "client.message.submitted":
    case "client.message.failed":
      return upsertMessage(
        data,
        {
          id: optimisticUserMessageId(event.data.submissionId),
          metadata: {
            optimistic: true,
            status: event.type === "client.message.failed" ? "failed" : "submitted",
          },
          parts: [{ type: "text", text: event.data.message }],
          role: "user",
        },
        event.type === "client.message.submitted" ? event.data.turnId : undefined,
      );

    case "input.resolved": {
      let next = data;
      for (const resolution of event.data.resolutions) {
        next = resolveInputRequest(next, resolution);
      }
      return next;
    }

    case "message.received":
      if (event.data.kind === "execution.background_task") return data;
      return upsertMessage(
        data,
        {
          id: `${receivedMessageEventId(event)}:user`,
          metadata: {
            status: "complete",
            turnId: event.data.turnId,
          },
          parts: projectReceivedParts(event.data.parts, event.data.message),
          role: "user",
        },
        event.data.turnId,
      );

    case "step.started":
      return updateAssistantMessage(data, event.data.turnId, (message) =>
        ensureStepStartPart(message, event.data.stepIndex),
      );

    case "step.completed": {
      const existing = data.messages.find(
        (message) => message.role === "assistant" && message.metadata?.turnId === event.data.turnId,
      );
      if (existing === undefined) return data;
      return updateAssistantMessage(data, event.data.turnId, (message) => ({
        ...message,
        parts: closeStreamingRuns(message.parts, event.data.stepIndex),
      }));
    }

    case "reasoning.appended":
      return updateAssistantMessage(data, event.data.turnId, (message) =>
        messageRun.transition(ensureStepStartPart(message, event.data.stepIndex), {
          kind: "append",
          delta: event.data.reasoningDelta,
          stepIndex: event.data.stepIndex,
          type: "reasoning",
        }),
      );

    case "reasoning.completed":
      return updateAssistantMessage(data, event.data.turnId, (message) =>
        messageRun.transition(ensureStepStartPart(message, event.data.stepIndex), {
          kind: "complete",
          stepIndex: event.data.stepIndex,
          text: event.data.reasoning,
          type: "reasoning",
        }),
      );

    case "action.input.appended": {
      const existing = findToolPart(data, event.data.callId);
      if (existing !== undefined && existing.state !== "input-streaming") return data;

      const inputText =
        (existing?.state === "input-streaming" ? existing.inputText : "") +
        event.data.inputTextDelta;

      const nextPart: EveDynamicToolPart = {
        input: undefined,
        inputText,
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

      return upsertToolPart(data, event.data.turnId, event.data.stepIndex, nextPart);
    }

    case "actions.requested": {
      let next = data;
      for (const action of event.data.actions) {
        const existing = findToolPart(next, action.callId);
        if (existing !== undefined && existing.state !== "input-streaming") continue;
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
        const existing = findToolPart(next, request.action.callId);
        if (
          existing?.approval?.id === request.requestId ||
          (existing !== undefined && isSettledToolPart(existing))
        )
          continue;
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
          ...toolPartIdentity(existing),
          approval: { approved: true, id: event.data.requestId, reason: undefined },
          state: "approval-responded",
        });
      }
      return updateToolPart(data, existing.toolCallId, {
        ...toolPartIdentity(existing),
        approval: {
          approved: false,
          id: event.data.requestId,
          reason: "Tool execution was cancelled.",
        },
        state: "output-denied",
      });
    }

    case "action.result": {
      const descriptor = normalizeActionResult(event.data.result);
      const existing = findToolPart(data, event.data.result.callId);
      const denied =
        event.data.status === "rejected" || event.data.error?.code === "TOOL_EXECUTION_DENIED";
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

      return upsertToolPart(data, event.data.turnId, event.data.stepIndex, nextPart);
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

      return upsertToolPart(data, event.data.turnId, event.data.stepIndex, nextPart);
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
        messageRun.transition(ensureStepStartPart(message, event.data.stepIndex), {
          kind: "append",
          delta: event.data.messageDelta,
          stepIndex: event.data.stepIndex,
          type: "text",
        }),
      );

    case "message.completed":
      return updateAssistantMessage(data, event.data.turnId, (message) =>
        messageRun.transition(ensureStepStartPart(message, event.data.stepIndex), {
          kind: "complete",
          stepIndex: event.data.stepIndex,
          text: event.data.message,
          type: "text",
        }),
      );

    case "result.completed":
      return updateAssistantMessage(data, event.data.turnId, (message) => ({
        ...message,
        metadata: { ...message.metadata, result: event.data.result },
      }));

    case "turn.completed":
      return updateAssistantMessage(data, event.data.turnId, (message) => ({
        ...message,
        metadata: { ...message.metadata, status: "complete" },
        parts: removeStreamingToolParts(closeStreamingRuns(message.parts)),
      }));

    case "turn.cancelled":
      // Finalize whatever the cancelled turn streamed: no message.completed
      // or reasoning.completed will follow a partial append.
      return updateAssistantMessage(data, event.data.turnId, (message) => ({
        ...message,
        metadata: { ...message.metadata, status: "complete" },
        parts: removeStreamingToolParts(closeStreamingRuns(message.parts)),
      }));

    case "turn.failed": {
      const existing = data.messages.find(
        (message) => message.role === "assistant" && message.metadata?.turnId === event.data.turnId,
      );
      if (existing === undefined) return data;
      return updateAssistantMessage(data, event.data.turnId, (message) => ({
        ...message,
        metadata: { ...message.metadata, status: "complete" },
        parts: removeStreamingToolParts(closeStreamingRuns(message.parts)),
      }));
    }

    case "session.failed":
      return data;

    default:
      return data;
  }
}

function closeStreamingRuns(
  parts: readonly EveMessagePart[],
  stepIndex?: number,
): readonly EveMessagePart[] {
  return parts.map((part) =>
    (part.type === "text" || part.type === "reasoning") &&
    part.state === "streaming" &&
    (stepIndex === undefined || part.stepIndex === stepIndex)
      ? { ...part, state: "done" }
      : part,
  );
}

function removeStreamingToolParts(parts: readonly EveMessagePart[]): readonly EveMessagePart[] {
  return parts.filter((part) => part.type !== "dynamic-tool" || part.state !== "input-streaming");
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
    ...toolPartIdentity(existing),
    approval,
    state: "approval-responded",
    toolMetadata: mergeToolMetadata(existing.toolMetadata, {
      eve: {
        inputResponse: response,
        kind: existing.toolMetadata?.eve?.kind ?? "unknown",
        name: existing.toolMetadata?.eve?.name ?? existing.toolName,
      },
    }),
  });
}

function resolveInputRequest(data: EveMessageData, resolution: InputResolution): EveMessageData {
  if (resolution.response !== undefined) {
    return respondToInputRequest(data, resolution.response);
  }

  const existing = findToolPartByApprovalId(data, resolution.requestId);
  if (!existing) return data;

  return updateToolPart(data, existing.toolCallId, {
    ...toolPartIdentity(existing),
    output: { status: resolution.outcome },
    state: "output-available",
  });
}

function toolPartIdentity(part: EveDynamicToolPart) {
  return {
    input: part.input,
    stepIndex: part.stepIndex,
    toolCallId: part.toolCallId,
    toolMetadata: part.toolMetadata,
    toolName: part.toolName,
    type: part.type,
  };
}

function updateAssistantMessage(
  data: EveMessageData,
  turnId: string,
  update: (message: EveAssistantMessage) => EveAssistantMessage,
): EveMessageData {
  const existing = data.messages.find(
    (message): message is EveAssistantMessage =>
      message.role === "assistant" && message.metadata?.turnId === turnId,
  );

  const message = existing ?? createAssistantMessage(turnId);
  return upsertMessage(data, update(message));
}

function createAssistantMessage(turnId: string): EveAssistantMessage {
  return {
    id: `${turnId}:assistant`,
    metadata: {
      status: "streaming",
      turnId,
    },
    parts: [],
    role: "assistant",
  };
}

function ensureStepStartPart(message: EveAssistantMessage, stepIndex: number): EveAssistantMessage {
  const stepStartCount = message.parts.filter((part) => part.type === "step-start").length;
  if (stepStartCount > stepIndex) {
    return message;
  }

  const missingCount = stepIndex - stepStartCount + 1;
  return {
    ...message,
    parts: [
      ...message.parts,
      ...Array.from({ length: missingCount }, () => ({ type: "step-start" as const })),
    ],
  };
}

function upsertPart(message: EveAssistantMessage, next: EveMessagePart): EveAssistantMessage {
  const index = message.parts.findIndex((part) => partKey(part) === partKey(next));
  const parts =
    index === -1
      ? [...message.parts, next]
      : [...message.parts.slice(0, index), next, ...message.parts.slice(index + 1)];

  return {
    ...message,
    metadata: {
      ...message.metadata,
      status: next.type === "text" && next.state === "done" ? "complete" : "streaming",
    },
    parts,
  };
}

function upsertToolPart(
  data: EveMessageData,
  turnId: string,
  stepIndex: number,
  part: EveDynamicToolPart,
): EveMessageData {
  // A later result still belongs to the turn that opened the call.
  const updated = updateToolPart(data, part.toolCallId, part);
  return updated !== data
    ? updated
    : updateAssistantMessage(data, turnId, (message) =>
        upsertPart(ensureStepStartPart(message, stepIndex), part),
      );
}

function updateToolPart(
  data: EveMessageData,
  toolCallId: string,
  next: EveDynamicToolPart,
): EveMessageData {
  const message = data.messages.find(
    (candidate): candidate is EveAssistantMessage =>
      candidate.role === "assistant" &&
      candidate.parts.some(
        (part) => part.type === "dynamic-tool" && part.toolCallId === toolCallId,
      ),
  );

  if (!message) {
    return data;
  }

  return upsertMessage(data, upsertPart(message, next));
}

function completeAuthorization(
  data: EveMessageData,
  event: AuthorizationCompletedStreamEvent,
): EveMessageData {
  const existing = findPendingAuthorizationPart(data, event.data.name, event.data.attemptId);
  const next = createAuthorizationCompletedPart(event, existing);

  const turnId = existing?.turnId ?? event.data.turnId;
  return updateAssistantMessage(data, turnId, (message) =>
    upsertPart(ensureStepStartPart(message, next.stepIndex), next),
  );
}

function findToolPart(data: EveMessageData, toolCallId: string): EveDynamicToolPart | undefined {
  for (const message of data.messages) {
    for (const part of message.parts) {
      if (part.type === "dynamic-tool" && part.toolCallId === toolCallId) {
        return part;
      }
    }
  }
  return undefined;
}

function isSettledToolPart(part: EveDynamicToolPart): boolean {
  return (
    part.state === "output-denied" ||
    part.state === "output-error" ||
    (part.state === "output-available" && part.partial !== true)
  );
}

function findPendingAuthorizationPart(
  data: EveMessageData,
  name: string,
  attemptId: string | undefined,
): EveAuthorizationPart | undefined {
  for (let messageIndex = data.messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = data.messages[messageIndex];
    if (message?.role !== "assistant") {
      continue;
    }

    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.parts[partIndex];
      if (
        part?.type === "authorization" &&
        part.state === "required" &&
        (attemptId === undefined
          ? part.attemptId === undefined && part.name === name
          : part.attemptId === attemptId)
      ) {
        return part;
      }
    }
  }

  return undefined;
}

function findToolPartByApprovalId(
  data: EveMessageData,
  approvalId: string,
): EveDynamicToolPart | undefined {
  for (const message of data.messages) {
    for (const part of message.parts) {
      if (part.type === "dynamic-tool" && part.approval?.id === approvalId) {
        return part;
      }
    }
  }
  return undefined;
}
