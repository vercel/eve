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
      return `authorization:${part.turnId}:${part.stepIndex}:${part.name}`;
    case "dynamic-tool":
      return `dynamic-tool:${part.toolCallId}`;
  }
}

export function upsertMessage(data: EveMessageData, next: EveMessage): EveMessageData {
  const index = data.messages.findIndex((message) => message.id === next.id);
  if (index === -1) {
    return { ...data, messages: [...data.messages, next] };
  }

  return {
    ...data,
    messages: [...data.messages.slice(0, index), next, ...data.messages.slice(index + 1)],
  };
}

export function removeStreamingToolPartsForTurn(
  data: EveMessageData,
  turnId: string,
): EveMessageData {
  const index = data.messages.findIndex(
    (message) => message.role === "assistant" && message.metadata?.turnId === turnId,
  );
  const message = data.messages[index];
  if (message === undefined) return data;

  return upsertMessage(data, {
    ...message,
    parts: message.parts.filter(
      (part) => part.type !== "dynamic-tool" || part.state !== "input-streaming",
    ),
  });
}

export function optimisticUserMessageId(submissionId: string): string {
  return `optimistic:${submissionId}:user`;
}

export function appendToolInputDelta(
  inputText: string | undefined,
  offset: number,
  delta: string,
): string | undefined {
  if (offset === 0) return delta;
  if (inputText?.length !== offset) return undefined;
  return inputText + delta;
}
