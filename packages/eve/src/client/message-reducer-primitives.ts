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
    return { messages: [...data.messages, next] };
  }

  return {
    messages: [...data.messages.slice(0, index), next, ...data.messages.slice(index + 1)],
  };
}

/**
 * Places a user message immediately before the assistant response for its
 * turn. A steering delivery is accepted while that response is already
 * streaming, so appending it would render the causal order backwards.
 *
 * Optimistic sends lack a durable turn id. In that case, use the currently
 * streaming assistant as the local anchor; the authoritative delivery later
 * replays with its exact turn id and keeps the same position.
 */
export function upsertUserMessage(
  data: EveMessageData,
  next: EveMessage & { readonly role: "user" },
  turnId?: string,
): EveMessageData {
  const messages = data.messages.filter((message) => message.id !== next.id);
  const assistantIndex =
    turnId === undefined
      ? messages.findLastIndex(
          (message) => message.role === "assistant" && message.metadata?.status === "streaming",
        )
      : messages.findIndex(
          (message) => message.role === "assistant" && message.metadata?.turnId === turnId,
        );

  if (assistantIndex === -1) {
    return { messages: [...messages, next] };
  }

  return {
    messages: [...messages.slice(0, assistantIndex), next, ...messages.slice(assistantIndex)],
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
