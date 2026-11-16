import type { SessionStreamEvent } from "eve/client";
import { calls, type CallObservation, type SessionView } from "eve/events";
import type { EveMessagePart } from "eve/react";
import {
  reactionTextFor,
  reactToMessageToolResultSchema,
} from "@shared/chat/reaction";
import { sendMessageToolResultSchema } from "@shared/chat/message-delivery";

export function messageTimestamps(events: readonly SessionStreamEvent[]) {
  const timestamps = imessageTimestamps(events);

  for (const event of events) {
    const turnId = event.scope?.turnId;
    if (
      event.type === "content.completed" &&
      event.data.kind === "text" &&
      event.data.phase === "reply" &&
      turnId !== undefined
    ) {
      timestamps.set(`${turnId}:assistant`, event.meta.at);
    }
  }

  return timestamps;
}

export function imessageTimestamps(events: readonly SessionStreamEvent[]) {
  const timestamps = new Map<string, string>();

  for (const event of events) {
    if (event.type === "delivery.consumed") {
      timestamps.set(`${event.data.deliveryId}:user`, event.meta.at);
    }
  }

  return timestamps;
}

export function sentMessages(view: SessionView) {
  const messagesByTurn = new Map<
    string,
    { id: string; parts: EveMessagePart[]; timestamp?: string }[]
  >();

  for (const settled of calls(view, { kind: "tool" })) {
    if (settled.state !== "completed" || settled.turnId === undefined) {
      continue;
    }
    const result = toolResult(settled);
    const delivery = sendMessageToolResultSchema.safeParse(result);
    const reaction = reactToMessageToolResultSchema.safeParse(result);
    const parts: EveMessagePart[] = [];
    if (reaction.success) {
      if (reaction.data.output.operation !== "add") continue;
      parts.push({
        state: "done",
        text: reactionTextFor(reaction.data.output.type),
        type: "text",
      });
    } else if (delivery.success) {
      const { output } = delivery.data;
      // Delivered text is plain and reaches the user verbatim. The chat view
      // renders text parts as Markdown, so keep every line break as a hard break.
      const text =
        output.kind === "link"
          ? output.url
          : output.text?.replaceAll("\n", "  \n");
      if (text) parts.push({ state: "done", text, type: "text" });
      const attachments = output.kind === "message" ? output.attachments : [];
      for (const attachment of attachments ?? []) {
        parts.push({
          filename: attachment.name,
          mediaType: attachment.mimeType ?? defaultMediaType[attachment.kind],
          type: "file",
          url: attachment.url,
        });
      }
    } else {
      continue;
    }

    const turnMessageId = `${settled.turnId}:assistant`;
    const messages = messagesByTurn.get(turnMessageId) ?? [];
    messages.push({
      id: `${turnMessageId}:${settled.callId}`,
      parts,
      timestamp: settled.endedAt,
    });
    messagesByTurn.set(turnMessageId, messages);
  }

  return messagesByTurn;
}

/**
 * The completed tool result shape the shared delivery schemas read: a v27
 * call carries its tool name on the call and its output on `call.settled`.
 */
function toolResult(settled: CallObservation) {
  return {
    kind: "tool-result" as const,
    output: settled.output,
    toolName: settled.name,
  };
}

const defaultMediaType = {
  audio: "audio/*",
  file: "application/octet-stream",
  image: "image/*",
  video: "video/*",
} as const;
