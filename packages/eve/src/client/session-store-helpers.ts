import { interaction } from "#protocol/session-projection/public-view.js";
import type { ConversationState } from "#client/conversation-state.js";
import type { SendTurnPayload } from "#client/types.js";
import type { MessageContent } from "#shared/message-content.js";

/** A server ignores answers to requests it already settled, so the store never sends them. */
export function assertAnswerable(input: SendTurnPayload, conversation: ConversationState): void {
  for (const { interactionId } of input.answers ?? []) {
    const status = interaction(conversation.view, interactionId)?.status;
    if (status !== undefined && status !== "open") {
      throw new Error(`Input request ${interactionId} was already answered.`);
    }
  }
}

export function assertExclusiveTurnInput(input: SendTurnPayload): void {
  if ((input.message !== undefined) === (input.answers !== undefined)) {
    throw new Error("A turn requires exactly one of message or answers.");
  }
}

export function summarizeMessage(message: MessageContent): string {
  if (typeof message === "string") return message;
  return message
    .flatMap((part) =>
      part.type === "text"
        ? [part.text]
        : part.type === "file"
          ? [part.filename ? `[file: ${part.filename}]` : "[file]"]
          : [],
    )
    .join("\n");
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
