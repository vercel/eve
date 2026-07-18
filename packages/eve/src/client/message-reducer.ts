import type { EveAgentReducer, EveAgentReducerEvent } from "#client/reducer.js";
import {
  createAuthorizationCompletedPart,
  createAuthorizationRequiredPart,
} from "#client/authorization-message-parts.js";
import type {
  EveAuthorizationPart,
  EveMessageData,
  EveDynamicToolPart,
  EveMessageInputRequest,
  EveMessage,
  EveMessageMetadata,
  EveMessagePart,
  EveMessageToolMetadata,
} from "#client/message-reducer-types.js";
import type { RuntimeActionRequest, RuntimeActionResult } from "#runtime/actions/types.js";
import type { InputRequest, InputResponse } from "#runtime/input/types.js";
import type { AuthorizationCompletedStreamEvent, MessageReceivedPart } from "#protocol/message.js";

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

interface ActionDescriptor {
  readonly kind: "load-skill" | "subagent-call" | "tool-call";
  readonly name: string;
  readonly toolName: string;
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
        upsertPart(ensureStepStartPart(message, event.data.stepIndex), {
          state: "streaming",
          stepIndex: event.data.stepIndex,
          text: event.data.reasoningSoFar,
          type: "reasoning",
        }),
      );

    case "reasoning.completed":
      return updateAssistantMessage(data, event.data.turnId, (message) =>
        upsertPart(ensureStepStartPart(message, event.data.stepIndex), {
          state: "done",
          stepIndex: event.data.stepIndex,
          text: event.data.reasoning,
          type: "reasoning",
        }),
      );

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
        upsertPart(ensureStepStartPart(message, event.data.stepIndex), {
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

        return upsertPart(ensureStepStartPart(message, event.data.stepIndex), {
          state: "done",
          stepIndex: event.data.stepIndex,
          text: event.data.message,
          type: "text",
        });
      });

    case "result.completed":
      return updateAssistantMetadata(data, event.data.turnId, { result: event.data.result });

    case "turn.completed":
      return updateAssistantMetadata(data, event.data.turnId, { status: "complete" });

    case "turn.cancelled":
      // Finalize whatever the cancelled turn streamed: no message.completed
      // or reasoning.completed will follow a partial append.
      return updateAssistantMessage(data, event.data.turnId, (message) => ({
        ...message,
        metadata: { ...message.metadata, status: "complete" },
        parts: message.parts.map((part) =>
          (part.type === "text" || part.type === "reasoning") && part.state === "streaming"
            ? { ...part, state: "done" }
            : part,
        ),
      }));

    case "turn.failed":
    case "session.failed":
      return data;

    default:
      return data;
  }
}

function respondToInputRequest(data: EveMessageData, response: InputResponse): EveMessageData {
  const existing = findToolPartByApprovalId(data, response.requestId);
  if (!existing) {
    return data;
  }

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

function updateAssistantMetadata(
  data: EveMessageData,
  turnId: string,
  metadata: EveMessageMetadata,
): EveMessageData {
  return updateAssistantMessage(data, turnId, (message) => ({
    ...message,
    metadata: {
      ...message.metadata,
      ...metadata,
    },
  }));
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

function removeTextPart(message: EveAssistantMessage, stepIndex: number): EveAssistantMessage {
  const parts = message.parts.filter(
    (part) => part.type !== "text" || part.stepIndex !== stepIndex,
  );
  if (parts.length === message.parts.length) {
    return message;
  }

  return {
    ...message,
    metadata: {
      ...message.metadata,
      status: "complete",
    },
    parts,
  };
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
  const existing = findLatestPendingAuthorizationPart(data, event.data.name);
  const next = createAuthorizationCompletedPart(event, existing);

  if (existing !== undefined) {
    return updateAuthorizationPart(data, existing, next);
  }

  return updateAssistantMessage(data, event.data.turnId, (message) =>
    upsertPart(ensureStepStartPart(message, event.data.stepIndex), next),
  );
}

function updateAuthorizationPart(
  data: EveMessageData,
  existing: EveAuthorizationPart,
  next: EveAuthorizationPart,
): EveMessageData {
  const message = data.messages.find(
    (candidate): candidate is EveAssistantMessage =>
      candidate.role === "assistant" && candidate.parts.some((part) => part === existing),
  );

  if (!message) {
    return data;
  }

  return upsertMessage(data, upsertPart(message, next));
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

function findLatestPendingAuthorizationPart(
  data: EveMessageData,
  name: string,
): EveAuthorizationPart | undefined {
  for (let messageIndex = data.messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = data.messages[messageIndex];
    if (message?.role !== "assistant") {
      continue;
    }

    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.parts[partIndex];
      if (part?.type === "authorization" && part.state === "required" && part.name === name) {
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

function projectReceivedParts(
  parts: readonly MessageReceivedPart[] | undefined,
  message: string,
): readonly EveMessagePart[] {
  return (
    parts?.map((part) =>
      part.type === "text"
        ? { state: "done", text: part.text, type: "text" }
        : {
            filename: part.filename,
            mediaType: part.mediaType,
            size: part.size,
            type: "file",
            url: part.url,
          },
    ) ?? [{ state: "done", text: message, type: "text" }]
  );
}

function partKey(part: EveMessagePart): string {
  switch (part.type) {
    case "text":
      return `text:${part.stepIndex ?? 0}`;
    case "reasoning":
      return `reasoning:${part.stepIndex ?? 0}`;
    case "file":
      return `file:${part.stepIndex ?? 0}:${part.filename ?? part.url ?? part.mediaType}`;
    case "step-start":
      return "step-start";
    case "authorization":
      return `authorization:${part.turnId}:${part.stepIndex}:${part.name}`;
    case "dynamic-tool":
      return `dynamic-tool:${part.toolCallId}`;
  }
}

function upsertMessage(data: EveMessageData, next: EveMessage): EveMessageData {
  const index = data.messages.findIndex((message) => message.id === next.id);
  if (index === -1) {
    return { messages: [...data.messages, next] };
  }

  return {
    messages: [...data.messages.slice(0, index), next, ...data.messages.slice(index + 1)],
  };
}

function toMessageInputRequest(request: InputRequest): EveMessageInputRequest {
  return {
    allowFreeform: request.allowFreeform,
    display: request.display,
    options: request.options,
    prompt: request.prompt,
    requestId: request.requestId,
  };
}

function createToolMetadata(
  descriptor: ActionDescriptor,
  extra?: { readonly inputRequest?: EveMessageInputRequest },
): EveMessageToolMetadata {
  return {
    eve: {
      inputRequest: extra?.inputRequest,
      kind: descriptor.kind,
      name: descriptor.name,
    },
  };
}

function mergeToolMetadata(
  current: EveMessageToolMetadata | undefined,
  next: EveMessageToolMetadata,
): EveMessageToolMetadata {
  const kind = next.eve?.kind ?? current?.eve?.kind ?? "unknown";
  const name = next.eve?.name ?? current?.eve?.name ?? "unknown";

  return {
    eve: {
      ...current?.eve,
      ...next.eve,
      inputRequest: next.eve?.inputRequest ?? current?.eve?.inputRequest,
      inputResponse: next.eve?.inputResponse ?? current?.eve?.inputResponse,
      kind,
      name,
    },
  };
}

function approvedApproval(part: EveDynamicToolPart | undefined):
  | {
      readonly id: string;
      readonly approved: true;
      readonly reason?: string;
      readonly isAutomatic?: boolean;
    }
  | undefined {
  if (!part?.approval?.id) {
    return undefined;
  }
  return {
    approved: true,
    id: part.approval.id,
    isAutomatic: part.approval.isAutomatic,
    reason: part.approval.reason,
  };
}

function normalizeActionRequest(action: RuntimeActionRequest): ActionDescriptor {
  switch (action.kind) {
    case "load-skill":
      return {
        kind: "load-skill",
        name: "load_skill",
        toolName: "eve:load-skill",
      };
    case "tool-call":
      return {
        kind: "tool-call",
        name: action.toolName,
        toolName: action.toolName,
      };
    case "subagent-call":
      return {
        kind: "subagent-call",
        name: action.subagentName,
        toolName: `eve:subagent:${action.subagentName}`,
      };
    case "remote-agent-call":
      return {
        kind: "subagent-call",
        name: action.remoteAgentName,
        toolName: `eve:subagent:${action.remoteAgentName}`,
      };
  }
}

function normalizeActionResult(result: RuntimeActionResult): ActionDescriptor {
  switch (result.kind) {
    case "load-skill-result":
      return {
        kind: "load-skill",
        name: result.name ?? "load_skill",
        toolName: "eve:load-skill",
      };
    case "tool-result":
      return {
        kind: "tool-call",
        name: result.toolName,
        toolName: result.toolName,
      };
    case "subagent-result":
      return {
        kind: "subagent-call",
        name: result.subagentName,
        toolName: `eve:subagent:${result.subagentName}`,
      };
  }
}

function optimisticUserMessageId(submissionId: string): string {
  return `optimistic:${submissionId}:user`;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "Action failed.";
  }
}
