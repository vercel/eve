import type { EveMessage, EveMessageData, EveMessagePart } from "#client/message-reducer-types.js";
import type { MessageReceivedPart } from "#protocol/message.js";

export function projectReceivedParts(
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

export function partKey(part: EveMessagePart): string {
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
      return part.attemptId === undefined
        ? `authorization:${part.turnId}:${part.stepIndex}:${part.name}`
        : `authorization:${part.attemptId}`;
    case "dynamic-tool":
      return `dynamic-tool:${part.toolCallId}`;
  }
}

export function upsertMessage(
  data: EveMessageData,
  next: EveMessage,
  beforeAssistantTurnId?: string,
): EveMessageData {
  const index = data.messages.findIndex((message) => message.id === next.id);
  if (index !== -1) {
    return {
      ...data,
      messages: [...data.messages.slice(0, index), next, ...data.messages.slice(index + 1)],
    };
  }
  const before =
    beforeAssistantTurnId === undefined
      ? -1
      : data.messages.findIndex(
          (message) =>
            message.role === "assistant" && message.metadata?.turnId === beforeAssistantTurnId,
        );
  if (before === -1) return { ...data, messages: [...data.messages, next] };
  return {
    ...data,
    messages: [...data.messages.slice(0, before), next, ...data.messages.slice(before)],
  };
}

export function optimisticUserMessageId(submissionId: string): string {
  return `optimistic:${submissionId}:user`;
}
