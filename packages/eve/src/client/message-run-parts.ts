import type { EveMessage, EveMessagePart } from "#client/message-reducer-types.js";
import { reduceContentRun, selectContentRun } from "#client/content-run.js";

type EveAssistantMessage = EveMessage & { readonly role: "assistant" };
type EveRunPart = Extract<EveMessagePart, { readonly type: "text" | "reasoning" }>;

function latestRunIndex(message: EveAssistantMessage, type: EveRunPart["type"], stepIndex: number) {
  return message.parts.findLastIndex((part) => part.type === type && part.stepIndex === stepIndex);
}

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
  const index = latestRunIndex(message, input.type, input.stepIndex);
  const previous = index === -1 ? undefined : (message.parts[index] as EveRunPart);
  const event =
    input.kind === "append"
      ? { type: "append" as const, delta: input.delta }
      : { type: "complete" as const, text: input.text };
  const selection = selectContentRun(
    previous === undefined ? undefined : { text: previous.text, status: previous.state ?? "done" },
    event,
  );
  if (selection === "ignore") return message;
  const current = selection === "current" ? previous : undefined;
  const change = reduceContentRun(
    current === undefined ? undefined : { text: current.text, status: "streaming" },
    event,
  );
  if (change.type === "ignore") return message;
  if (change.type === "remove") {
    if (!current) return message;
    return {
      ...message,
      metadata: { ...message.metadata, status: "complete" },
      parts: [...message.parts.slice(0, index), ...message.parts.slice(index + 1)],
    };
  }
  const part: EveRunPart = {
    state: change.run.status,
    stepIndex: input.stepIndex,
    text: change.run.text,
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
