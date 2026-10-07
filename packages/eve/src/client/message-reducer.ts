import {
  conversationProjection,
  withConversationProjection,
} from "#client/conversation-projection.js";
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
import type { AuthorizationCompletedStreamEvent } from "#protocol/message.js";
import {
  foldSession,
  initialSessionProjection,
  reportedCallStatus,
  type SessionProjection,
} from "#protocol/session-projection.js";
import { toolPartState } from "#client/tool-part-state.js";

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
type HistoryImportedEvent = Extract<EveAgentReducerEvent, { readonly type: "history.imported" }>;

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
 * responses, and authorization prompts. A tool part's `state` comes from the
 * session projection the data carries, the same lifecycle every eve reader
 * folds; its events supply only the part's content.
 */
export function defaultMessageReducer(): EveAgentReducer<EveMessageData> {
  return {
    initial() {
      return withConversationProjection({ messages: [] }, initialSessionProjection());
    },
    reduce(data, event) {
      return reduceMessageData(data, event);
    },
  };
}

function reduceMessageData(data: EveMessageData, event: EveAgentReducerEvent): EveMessageData {
  const projection = foldSession(conversationProjection(data), event);
  const content = withConversationProjection(reduceContent(data, event), projection);
  const callIds = toolCallIds(content, event);
  return withConversationProjection(
    callIds.length === 0 ? content : withToolPartStates(content, callIds),
    projection,
  );
}

/** What an event says about the conversation's messages and parts. */
function reduceContent(data: EveMessageData, event: EveAgentReducerEvent): EveMessageData {
  switch (event.type) {
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
        event.data.turnId,
      );

    case "message.received":
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

    case "history.imported":
      return importHistory(data, event);

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
          id: event.meta?.id,
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
          id: event.meta?.id,
          type: "reasoning",
        }),
      );

    case "action.input.appended": {
      const existing = findToolPart(data, event.data.callId);
      if (existing !== undefined && existing.state !== "input-streaming") return data;
      const inputText =
        (existing?.state === "input-streaming" ? existing.inputText : "") +
        event.data.inputTextDelta;
      return upsertToolPart(data, event.data.turnId, event.data.stepIndex, {
        input: undefined,
        inputText,
        state: "input-streaming",
        stepIndex: event.data.stepIndex,
        toolCallId: event.data.callId,
        toolMetadata: existing?.toolMetadata ?? {
          eve: { kind: "unknown", name: event.data.toolName },
        },
        toolName: event.data.toolName,
        type: "dynamic-tool",
      });
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
        ) {
          continue;
        }
        const descriptor = normalizeActionRequest(request.action);
        next = updateAssistantMessage(next, event.data.turnId, (message) =>
          upsertPart(ensureStepStartPart(message, event.data.stepIndex), {
            ...existing,
            approval: { id: request.requestId },
            input: request.action.input,
            state: "approval-requested",
            stepIndex: existing?.stepIndex ?? event.data.stepIndex,
            toolCallId: request.action.callId,
            toolMetadata: createToolMetadata(descriptor, {
              inputRequest: toMessageInputRequest(request),
            }),
            toolName: descriptor.toolName,
            type: "dynamic-tool",
          } as EveDynamicToolPart),
        );
      }
      return next;
    }

    case "action.result": {
      // A task call's result is only its start receipt, which can arrive after the task settled.
      if (conversationProjection(data).calls[event.data.result.callId]?.taskId !== undefined)
        return data;
      // A retried model-call attempt's calls never ran; the replacement attempt re-requests them.
      if (event.data.error?.code === "MODEL_CALL_ATTEMPT_RETRIED") {
        return updateAssistantMessage(data, event.data.turnId, (message) => ({
          ...message,
          parts: message.parts.filter(
            (part) => part.type !== "dynamic-tool" || part.toolCallId !== event.data.result.callId,
          ),
        }));
      }
      const existing = findToolPart(data, event.data.result.callId);
      const descriptor = normalizeActionResult(event.data.result);
      const succeeded =
        event.data.status === undefined || event.data.status === "completed"
          ? event.data.result.isError !== true && event.data.error === undefined
          : false;
      const part = {
        ...existing,
        input: existing?.input,
        stepIndex: existing?.stepIndex ?? event.data.stepIndex,
        toolCallId: event.data.result.callId,
        toolMetadata: mergeToolMetadata(existing?.toolMetadata, createToolMetadata(descriptor)),
        toolName: existing?.toolName ?? descriptor.toolName,
        type: "dynamic-tool" as const,
      };
      const outcome = succeeded
        ? { errorText: undefined, output: event.data.result.output }
        : {
            errorText: event.data.error?.message ?? stringifyUnknown(event.data.result.output),
            output: undefined,
          };
      return upsertToolPart(data, event.data.turnId, event.data.stepIndex, {
        ...part,
        ...outcome,
        partial: undefined,
      } as EveDynamicToolPart);
    }

    case "action.partial": {
      const existing = findToolPart(data, event.data.result.callId);
      if (existing !== undefined && isSettledToolPart(existing)) return data;
      const descriptor = normalizeActionResult(event.data.result);
      return upsertToolPart(data, event.data.turnId, event.data.stepIndex, {
        ...existing,
        input: existing?.input,
        output: event.data.result.output,
        partial: true,
        state: "output-available",
        stepIndex: existing?.stepIndex ?? event.data.stepIndex,
        toolCallId: event.data.result.callId,
        toolMetadata: mergeToolMetadata(existing?.toolMetadata, createToolMetadata(descriptor)),
        toolName: existing?.toolName ?? descriptor.toolName,
        type: "dynamic-tool",
      } as EveDynamicToolPart);
    }

    case "input.resolved": {
      let next = data;
      for (const { requestId, response } of event.data.resolutions) {
        const existing =
          response === undefined ? undefined : findToolPartByApprovalId(next, requestId);
        if (existing === undefined) continue;
        next = replaceToolPart(next, {
          ...existing,
          toolMetadata: mergeToolMetadata(existing.toolMetadata, {
            eve: {
              inputResponse: response,
              kind: existing.toolMetadata?.eve?.kind ?? "unknown",
              name: existing.toolMetadata?.eve?.name ?? existing.toolName,
            },
          }),
        });
      }
      return next;
    }

    // A task's outcome is its call's: the call's `action.result` was only the start receipt.
    case "task.settled": {
      const existing = findToolPart(data, event.data.callId);
      if (existing === undefined) return data;
      const { error, output, status } = event.data;
      const outcome = status === "completed" ? { output } : { errorText: error?.message };
      return replaceToolPart(data, { ...existing, ...outcome } as EveDynamicToolPart);
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
          id: event.meta?.id,
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
          id: event.meta?.id,
          type: "text",
        }),
      );

    case "result.completed":
      return updateAssistantMessage(data, event.data.turnId, (message) => ({
        ...message,
        metadata: { ...message.metadata, result: event.data.result },
      }));

    case "turn.completed":
    case "turn.cancelled":
    case "turn.failed": {
      // A failed turn that streamed nothing has no message to finalize. Otherwise finalize what
      // the turn streamed: no completion follows a partial append.
      if (
        event.type === "turn.failed" &&
        !data.messages.some(
          (message) =>
            message.role === "assistant" && message.metadata?.turnId === event.data.turnId,
        )
      ) {
        return data;
      }
      return updateAssistantMessage(data, event.data.turnId, (message) => ({
        ...message,
        metadata: { ...message.metadata, status: "complete" },
        parts: removeUnsettledToolParts(
          closeStreamingRuns(message.parts),
          conversationProjection(data),
        ),
      }));
    }

    default:
      return data;
  }
}

/**
 * Added history precedes its turn's message: before that turn's response and any message the
 * client submitted and the stream hasn't confirmed. App ids become message ids so annotations can
 * rejoin.
 */
function importHistory(data: EveMessageData, event: HistoryImportedEvent): EveMessageData {
  const imported = event.data.messages.map((message, index): EveMessage => ({
    id:
      message.id ??
      `${event.meta.id ?? `${event.data.turnId}:${event.data.sequence}`}:imported:${index}`,
    // No `turnId`: the turn's response must never stream into an imported assistant message.
    metadata: { imported: true, status: "complete" },
    parts: [
      message.role === "assistant"
        ? { state: "done", text: message.text, type: "text" }
        : { text: message.text, type: "text" },
    ],
    role: message.role,
  }));
  const ids = new Set(imported.map((message) => message.id));
  const messages = data.messages.filter((message) => !ids.has(message.id));
  const before = messages.findIndex(
    (message) =>
      message.metadata?.optimistic === true ||
      (message.role === "assistant" && message.metadata?.turnId === event.data.turnId),
  );
  const at = before === -1 ? messages.length : before;
  return { ...data, messages: [...messages.slice(0, at), ...imported, ...messages.slice(at)] };
}

/** The tool calls whose state the event may have changed. */
function toolCallIds(data: EveMessageData, event: EveAgentReducerEvent): readonly string[] {
  const byRequest = (requestId: string) =>
    findToolPartByApprovalId(data, requestId)?.toolCallId ?? [];
  switch (event.type) {
    case "actions.requested":
      return event.data.actions.map((action) => action.callId);
    case "input.requested":
      return event.data.requests.map((request) => request.action.callId);
    case "action.result":
    case "action.partial":
      return [event.data.result.callId];
    case "task.started":
    case "task.settled":
      return [event.data.callId];
    case "input.resolved":
      return event.data.resolutions.flatMap((resolution) => byRequest(resolution.requestId));
    case "approval.settled":
      return [byRequest(event.data.requestId)].flat();
    default:
      return [];
  }
}

function withToolPartStates(data: EveMessageData, callIds: readonly string[]): EveMessageData {
  let next = data;
  for (const callId of new Set(callIds)) {
    const part = findToolPart(next, callId);
    if (part === undefined) continue;
    const derived = toolPartState(next, part);
    if (derived !== part) {
      next = withConversationProjection(
        replaceToolPart(next, derived),
        conversationProjection(data),
      );
    }
  }
  return next;
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

/**
 * Drops tool parts a finished turn left without a result: input that never finished streaming,
 * and validated requests whose call never ran. A task call outlives its turn, a call awaiting
 * input still has a pending request, and a call the projection doesn't know keeps its state.
 */
function removeUnsettledToolParts(
  parts: readonly EveMessagePart[],
  projection: SessionProjection,
): readonly EveMessagePart[] {
  return parts.filter((part) => {
    if (part.type !== "dynamic-tool") return true;
    if (part.state === "input-streaming") return false;
    if (part.state !== "input-available") return true;
    const call = projection.calls[part.toolCallId];
    return (
      call === undefined ||
      call.taskId !== undefined ||
      reportedCallStatus(projection, call) !== "running"
    );
  });
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

/**
 * Swaps a tool part in place without touching the message status: a task
 * usually settles after the turn that called it has completed.
 */
function replaceToolPart(data: EveMessageData, next: EveDynamicToolPart): EveMessageData {
  const message = data.messages.find((candidate) =>
    candidate.parts.some(
      (part) => part.type === "dynamic-tool" && part.toolCallId === next.toolCallId,
    ),
  );
  if (message === undefined) return data;

  return upsertMessage(data, {
    ...message,
    parts: message.parts.map((part) => (partKey(part) === partKey(next) ? next : part)),
  });
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
