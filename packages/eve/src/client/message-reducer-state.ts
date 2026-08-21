import type {
  EveAuthorizationPart,
  EveDynamicToolPart,
  EveMessage,
  EveMessageData,
  EveMessageMetadata,
  EveMessagePart,
} from "#client/message-reducer-types.js";
import type { MessageReceivedPart } from "#protocol/message.js";

export type EveAssistantMessage = EveMessage & { readonly role: "assistant" };

export function projectReceivedParts(
  parts: readonly MessageReceivedPart[] | undefined,
  message: string,
): readonly EveMessagePart[] {
  return (
    parts?.map((part) =>
      "text" in part
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

export function upsertMessage(data: EveMessageData, next: EveMessage): EveMessageData {
  const index = data.messages.findIndex((message) => message.id === next.id);
  if (index === -1) {
    return { messages: [...data.messages, next] };
  }
  if (data.messages[index] === next) return data;

  return {
    messages: [...data.messages.slice(0, index), next, ...data.messages.slice(index + 1)],
  };
}

export function optimisticUserMessageId(submissionId: string): string {
  return `optimistic:${submissionId}:user`;
}

export function updateAssistantMessage(
  data: EveMessageData,
  turnId: string,
  update: (message: EveAssistantMessage) => EveAssistantMessage,
): EveMessageData {
  const message = findAssistantMessage(data, turnId) ?? createAssistantMessage(turnId);
  return upsertMessage(data, update(message));
}

export function updateExistingAssistantMessage(
  data: EveMessageData,
  turnId: string,
  update: (message: EveAssistantMessage) => EveAssistantMessage,
): EveMessageData {
  const message = findAssistantMessage(data, turnId);
  return message === undefined ? data : upsertMessage(data, update(message));
}

export function updateAssistantMetadata(
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

export function ensureStepStartPart(
  message: EveAssistantMessage,
  stepIndex: number,
): EveAssistantMessage {
  const stepStartCount = message.parts.filter((part) => part.type === "step-start").length;
  if (stepStartCount > stepIndex) return message;

  const missingCount = stepIndex - stepStartCount + 1;
  return {
    ...message,
    parts: [
      ...message.parts,
      ...Array.from({ length: missingCount }, () => ({ type: "step-start" as const })),
    ],
  };
}

export function upsertPart(
  message: EveAssistantMessage,
  next: EveMessagePart,
): EveAssistantMessage {
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

type EveRunPart = Extract<EveMessagePart, { readonly type: "text" | "reasoning" }>;

// Upserts a text/reasoning part, keeping multiple runs per step distinct: one
// step can produce text, call tools, then produce more text (see
// `MessageCompletedStreamEvent`), so a step-only key would collapse them.
//
// We find the latest same-step run of this type: while it is still streaming,
// its snapshots replace it in place; once it is done (or there is none), `next`
// begins a new run appended in arrival order.
export function upsertRun(message: EveAssistantMessage, next: EveRunPart): EveAssistantMessage {
  let lastIndex = -1;
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index];
    if (part?.type === next.type && part.stepIndex === next.stepIndex) {
      lastIndex = index;
      break;
    }
  }

  const openRun =
    lastIndex !== -1 && (message.parts[lastIndex] as EveRunPart).state === "streaming";
  const parts = openRun
    ? [...message.parts.slice(0, lastIndex), next, ...message.parts.slice(lastIndex + 1)]
    : [...message.parts, next];

  return {
    ...message,
    metadata: {
      ...message.metadata,
      status: next.type === "text" && next.state === "done" ? "complete" : "streaming",
    },
    parts,
  };
}

export function removeTextPart(
  message: EveAssistantMessage,
  stepIndex: number,
): EveAssistantMessage {
  const parts = message.parts.filter(
    (part) => part.type !== "text" || part.stepIndex !== stepIndex,
  );
  if (parts.length === message.parts.length) return message;

  return {
    ...message,
    metadata: {
      ...message.metadata,
      status: "complete",
    },
    parts,
  };
}

export function removeStreamingToolParts(
  parts: readonly EveMessagePart[],
): readonly EveMessagePart[] {
  const next = parts.filter(
    (part) => part.type !== "dynamic-tool" || part.state !== "input-streaming",
  );
  return next.length === parts.length ? parts : next;
}

export function updateToolPart(
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
  return message === undefined ? data : upsertMessage(data, upsertPart(message, next));
}

export function updateAuthorizationPart(
  data: EveMessageData,
  existing: EveAuthorizationPart,
  next: EveAuthorizationPart,
): EveMessageData {
  const message = data.messages.find(
    (candidate): candidate is EveAssistantMessage =>
      candidate.role === "assistant" && candidate.parts.some((part) => part === existing),
  );
  return message === undefined ? data : upsertMessage(data, upsertPart(message, next));
}

export function findToolPart(
  data: EveMessageData,
  toolCallId: string,
): EveDynamicToolPart | undefined {
  for (const message of data.messages) {
    for (const part of message.parts) {
      if (part.type === "dynamic-tool" && part.toolCallId === toolCallId) return part;
    }
  }
  return undefined;
}

export function findLatestPendingAuthorizationPart(
  data: EveMessageData,
  name: string,
): EveAuthorizationPart | undefined {
  for (let messageIndex = data.messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = data.messages[messageIndex];
    if (message?.role !== "assistant") continue;

    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.parts[partIndex];
      if (part?.type === "authorization" && part.state === "required" && part.name === name) {
        return part;
      }
    }
  }
  return undefined;
}

export function findToolPartByApprovalId(
  data: EveMessageData,
  approvalId: string,
): EveDynamicToolPart | undefined {
  for (const message of data.messages) {
    for (const part of message.parts) {
      if (part.type === "dynamic-tool" && part.approval?.id === approvalId) return part;
    }
  }
  return undefined;
}

function findAssistantMessage(
  data: EveMessageData,
  turnId: string,
): EveAssistantMessage | undefined {
  return data.messages.find(
    (message): message is EveAssistantMessage =>
      message.role === "assistant" && message.metadata?.turnId === turnId,
  );
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
