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
  normalizeCapability,
  settledLabel,
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
import { actionLabel } from "#shared/action-label.js";
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
  const content = withConversationProjection(reduceContent(data, event, projection), projection);
  const callIds = toolCallIds(content, event);
  return withConversationProjection(
    callIds.length === 0 ? content : withToolPartStates(content, callIds),
    projection,
  );
}

/** Where a model run's parts go: its turn, and its step in the turn. */
function runPlace(
  before: SessionProjection,
  after: SessionProjection,
  runId: string | undefined,
): { readonly turnId: string; readonly stepIndex: number } | undefined {
  if (runId === undefined) return undefined;
  const run = after.runs?.[runId] ?? before.runs?.[runId];
  if (run?.turnId === undefined) return undefined;
  return { stepIndex: run.stepIndex ?? 0, turnId: run.turnId };
}

/**
 * What an event says about the conversation's messages and parts. `after` is the projection with
 * the event folded in; the data still carries the one before it.
 */
function reduceContent(
  data: EveMessageData,
  event: EveAgentReducerEvent,
  after: SessionProjection,
): EveMessageData {
  const before = conversationProjection(data);
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

    case "delivery.consumed":
      // An answer or context-only delivery sends no message.
      if (event.data.parts.length === 0) return data;
      return upsertMessage(
        data,
        {
          id: `${event.data.deliveryId}:user`,
          metadata: {
            status: "complete",
            turnId: event.data.turnId,
          },
          parts: projectReceivedParts(event.data.parts),
          role: "user",
        },
        event.data.turnId,
      );

    case "model.requested": {
      const place = runPlace(before, after, event.data.runId);
      if (place === undefined) return data;
      return updateAssistantMessage(data, place.turnId, (message) =>
        ensureStepStartPart(message, place.stepIndex),
      );
    }

    case "model.settled": {
      const place = runPlace(before, after, event.data.runId);
      if (place === undefined) return data;
      const existing = data.messages.find(
        (message) => message.role === "assistant" && message.metadata?.turnId === place.turnId,
      );
      if (existing === undefined) return data;
      // A run a retry replaced leaves its unfinished output behind.
      return updateAssistantMessage(data, place.turnId, (message) => ({
        ...message,
        parts:
          event.data.outcome === "abandoned"
            ? message.parts.filter(
                (part) =>
                  !(
                    (part.type === "text" || part.type === "reasoning") &&
                    part.state === "streaming" &&
                    part.stepIndex === place.stepIndex
                  ) && !(part.type === "dynamic-tool" && part.state === "input-streaming"),
              )
            : closeStreamingRuns(message.parts, place.stepIndex),
      }));
    }

    case "content.delta": {
      const { delta, kind, partId } = event.data;
      const existing = findRunPart(data, partId);
      const place = existing ?? runPlace(before, after, event.scope?.runId);
      const declared = kind ?? existing?.type;
      const type = isRunKind(declared) ? declared : undefined;
      if (place === undefined || type === undefined) return data;
      return updateAssistantMessage(data, place.turnId, (message) =>
        messageRun.transition(ensureStepStartPart(message, place.stepIndex), {
          delta,
          id: partId,
          kind: "append",
          stepIndex: place.stepIndex,
          type,
        }),
      );
    }

    case "content.completed": {
      const { kind, partId, runId, value } = event.data;
      const place = runPlace(before, after, runId) ?? findRunPart(data, partId);
      if (place === undefined) return data;
      if (kind === "result") {
        return updateAssistantMessage(data, place.turnId, (message) => ({
          ...message,
          metadata: { ...message.metadata, result: value },
        }));
      }
      const type = isRunKind(kind) ? kind : undefined;
      if (type === undefined || typeof value !== "string") return data;
      return updateAssistantMessage(data, place.turnId, (message) =>
        messageRun.transition(ensureStepStartPart(message, place.stepIndex), {
          id: partId,
          kind: "complete",
          stepIndex: place.stepIndex,
          text: value,
          type,
        }),
      );
    }

    case "call.input": {
      const existing = findToolPart(data, event.data.callId);
      if (existing !== undefined && existing.state !== "input-streaming") return data;
      const place =
        findToolPlace(data, event.data.callId) ?? runPlace(before, after, event.scope?.runId);
      if (place === undefined) return data;
      const toolName = event.data.name ?? existing?.toolName ?? "unknown";
      const inputText =
        (existing?.state === "input-streaming" ? existing.inputText : "") + event.data.delta;
      return upsertToolPart(data, place.turnId, place.stepIndex, {
        input: undefined,
        inputText,
        state: "input-streaming",
        stepIndex: place.stepIndex,
        toolCallId: event.data.callId,
        toolMetadata: existing?.toolMetadata ?? { eve: { kind: "unknown", name: toolName } },
        toolName,
        type: "dynamic-tool",
      });
    }

    case "call.requested": {
      const { callId, capability, owner } = event.data;
      const existing = findToolPart(data, callId);
      if (existing !== undefined && existing.state !== "input-streaming") return data;
      const call = after.calls[callId];
      const place =
        "runId" in owner
          ? runPlace(before, after, owner.runId)
          : call === undefined
            ? undefined
            : { stepIndex: call.stepIndex, turnId: call.turnId };
      if (place === undefined) return data;
      const descriptor = normalizeCapability(capability);
      return updateAssistantMessage(data, place.turnId, (message) =>
        upsertPart(ensureStepStartPart(message, place.stepIndex), {
          input: event.data.input,
          state: "input-available",
          stepIndex: place.stepIndex,
          toolCallId: callId,
          toolMetadata: createToolMetadata(descriptor, {
            label: settledLabel(undefined, capability.title, descriptor),
          }),
          toolName: descriptor.toolName,
          type: "dynamic-tool",
        }),
      );
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
              label: existing?.toolMetadata?.eve?.label ?? actionLabel(request.action, undefined),
            }),
            toolName: descriptor.toolName,
            type: "dynamic-tool",
          } as EveDynamicToolPart),
        );
      }
      return next;
    }

    case "call.settled": {
      const { callId } = event.data;
      // A task's call settles through its task; its own result was the start receipt.
      if (before.calls[callId]?.taskId !== undefined && event.scope?.taskId === undefined) {
        return data;
      }
      // A retried model-call attempt's calls may never have run; the replacement re-requests them.
      if (event.data.outcome === "abandoned") {
        return removeToolPart(data, callId);
      }
      const existing = findToolPart(data, callId);
      const call = before.calls[callId];
      const turnId = call?.turnId ?? event.scope?.turnId;
      if (existing === undefined && turnId === undefined) return data;
      const part = {
        ...existing,
        input: existing?.input,
        stepIndex: existing?.stepIndex ?? call?.stepIndex ?? 0,
        toolCallId: callId,
        toolMetadata: mergeToolMetadata(existing?.toolMetadata, {
          eve: {
            kind: existing?.toolMetadata?.eve?.kind ?? "tool-call",
            label: event.data.title,
            name: existing?.toolMetadata?.eve?.name ?? call?.name ?? "unknown",
          },
        }),
        toolName: existing?.toolName ?? call?.name ?? "unknown",
        type: "dynamic-tool" as const,
      };
      const outcome =
        event.data.outcome === "completed"
          ? { errorText: undefined, output: event.data.output }
          : {
              errorText: event.data.error?.message ?? stringifyUnknown(event.data.output),
              output: undefined,
            };
      return upsertToolPart(data, turnId ?? "", part.stepIndex, {
        ...part,
        ...outcome,
        partial: undefined,
      } as EveDynamicToolPart);
    }

    case "call.progress": {
      const existing = findToolPart(data, event.data.callId);
      if (existing === undefined || isSettledToolPart(existing)) return data;
      return replaceToolPart(data, {
        ...existing,
        output: event.data.output,
        partial: true,
        state: "output-available",
        toolMetadata: mergeToolMetadata(existing.toolMetadata, {
          eve: {
            kind: existing.toolMetadata?.eve?.kind ?? "tool-call",
            label: event.data.title,
            name: existing.toolMetadata?.eve?.name ?? "unknown",
          },
        }),
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

    case "turn.settled": {
      // A failed turn that streamed nothing has no message to finalize. Otherwise finalize what
      // the turn streamed.
      const { outcome, turnId } = event.data;
      if (
        outcome === "failed" &&
        !data.messages.some(
          (message) => message.role === "assistant" && message.metadata?.turnId === turnId,
        )
      ) {
        return data;
      }
      return updateAssistantMessage(data, turnId, (message) => ({
        ...message,
        metadata: { ...message.metadata, status: "complete" },
        parts: removeUnsettledToolParts(closeStreamingRuns(message.parts), after),
      }));
    }

    default:
      return data;
  }
}

/** The tool calls whose state the event may have changed. */
function toolCallIds(data: EveMessageData, event: EveAgentReducerEvent): readonly string[] {
  const byRequest = (requestId: string) =>
    findToolPartByApprovalId(data, requestId)?.toolCallId ?? [];
  switch (event.type) {
    case "call.requested":
    case "call.started":
    case "call.settled":
    case "call.progress":
      return [event.data.callId];
    case "input.requested":
      return event.data.requests.map((request) => request.action.callId);
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

/** True for the content kinds a message streams as text: its text and its reasoning. */
function isRunKind(kind: string | undefined): kind is "text" | "reasoning" {
  return kind === "text" || kind === "reasoning";
}

/** Where a text or reasoning part already sits: its turn and step, and its type. */
function findRunPart(
  data: EveMessageData,
  partId: string,
):
  | { readonly turnId: string; readonly stepIndex: number; readonly type: "text" | "reasoning" }
  | undefined {
  for (const message of data.messages) {
    if (message.role !== "assistant" || message.metadata?.turnId === undefined) continue;
    for (const part of message.parts) {
      if ((part.type === "text" || part.type === "reasoning") && part.id === partId) {
        return { stepIndex: part.stepIndex ?? 0, turnId: message.metadata.turnId, type: part.type };
      }
    }
  }
  return undefined;
}

/** Where a tool part already sits: its turn and step. */
function findToolPlace(
  data: EveMessageData,
  toolCallId: string,
): { readonly turnId: string; readonly stepIndex: number } | undefined {
  for (const message of data.messages) {
    if (message.role !== "assistant" || message.metadata?.turnId === undefined) continue;
    for (const part of message.parts) {
      if (part.type === "dynamic-tool" && part.toolCallId === toolCallId) {
        return { stepIndex: part.stepIndex ?? 0, turnId: message.metadata.turnId };
      }
    }
  }
  return undefined;
}

function removeToolPart(data: EveMessageData, toolCallId: string): EveMessageData {
  const message = data.messages.find((candidate) =>
    candidate.parts.some((part) => part.type === "dynamic-tool" && part.toolCallId === toolCallId),
  );
  if (message === undefined) return data;
  return upsertMessage(data, {
    ...message,
    parts: message.parts.filter(
      (part) => part.type !== "dynamic-tool" || part.toolCallId !== toolCallId,
    ),
  });
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
