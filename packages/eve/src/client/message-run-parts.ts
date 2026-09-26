import type { EveMessage, EveMessagePart } from "#client/message-reducer-types.js";

type EveAssistantMessage = EveMessage & { readonly role: "assistant" };
type EveRunPart = Extract<EveMessagePart, { readonly type: "text" | "reasoning" }>;

function transition(
  message: EveAssistantMessage,
  input: {
    readonly stepIndex: number;
    readonly type: EveRunPart["type"];
  } & (
    | { readonly kind: "append"; readonly delta: string }
    | { readonly kind: "complete"; readonly text: string | null }
  ),
): EveAssistantMessage {
  const index = message.parts.findLastIndex(
    (part) => part.type === input.type && part.stepIndex === input.stepIndex,
  );
  const previous = index === -1 ? undefined : (message.parts[index] as EveRunPart);
  if (input.kind === "append" && !input.delta) return message;
  if (input.kind === "complete" && input.text === null && previous?.state !== "streaming")
    return message;
  const current = previous?.state === "streaming" ? previous : undefined;
  if (input.kind === "complete" && input.text === null) {
    return {
      ...message,
      metadata: { ...message.metadata, status: "complete" },
      parts: [...message.parts.slice(0, index), ...message.parts.slice(index + 1)],
    };
  }
  const part: EveRunPart = {
    state: input.kind === "append" ? "streaming" : "done",
    stepIndex: input.stepIndex,
    text: input.kind === "append" ? (current?.text ?? "") + input.delta : (input.text ?? ""),
    type: input.type,
  };
  const parts = current
    ? [...message.parts.slice(0, index), part, ...message.parts.slice(index + 1)]
    : [...message.parts, part];
  return {
    ...message,
    metadata: {
      ...message.metadata,
      status: input.type === "text" && part.state === "done" ? "complete" : "streaming",
    },
    parts,
  };
}

export const messageRun = { transition } as const;
