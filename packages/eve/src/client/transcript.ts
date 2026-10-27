import type { SessionStreamEvent } from "#protocol/session-event.js";
import type { UserPart } from "#protocol/session-events/envelope.js";

/** One user message or completed assistant message in a {@link TranscriptData}. */
export interface TranscriptMessage {
  readonly role: "assistant" | "user";
  readonly text: string;
}

/** A session's text conversation, as {@link transcriptOf} reads it. */
export interface TranscriptData {
  /** Messages since the session's last clear, oldest first. */
  readonly messages: readonly TranscriptMessage[];
}

/** Options for {@link transcriptOf}. */
export interface TranscriptOptions {
  /**
   * Most recent messages kept; older ones are dropped as new ones arrive.
   * A positive integer. Unbounded when omitted.
   */
  readonly maxMessages?: number;
}

/**
 * A session's text conversation, from its stream: imported history, user message text, and
 * completed assistant text, oldest first.
 *
 * The user's text is what each consumed delivery carries, after the history it imported; the
 * assistant's is each completed reply part. When one line consumes several deliveries, their
 * history comes before their messages, as the model reads them. Reasoning, narration, tool calls
 * and results, attachments, interactions, and interrupted or unfinished output are left out. A completed clear (`context.settled` selecting
 * nothing), or a reset that ended a stranded session, starts the transcript over, so text the
 * session no longer holds is never returned.
 *
 * @example
 * ```ts
 * import { transcriptOf } from "eve/client";
 * import { sessions } from "eve/server";
 *
 * const events = [];
 * for await (const event of sessions.attach(sessionId).stream({ follow: false })) events.push(event);
 * const { messages } = transcriptOf(events, { maxMessages: 40 });
 * ```
 *
 * @throws When `maxMessages` is not a positive integer.
 */
export function transcriptOf(
  events: Iterable<SessionStreamEvent>,
  options: TranscriptOptions = {},
): TranscriptData {
  const { maxMessages } = options;
  if (maxMessages !== undefined && (!Number.isSafeInteger(maxMessages) || maxMessages <= 0)) {
    throw new TypeError(
      `transcriptOf: "maxMessages" must be a positive integer; received ${String(maxMessages)}.`,
    );
  }
  let messages: TranscriptMessage[] = [];
  let resetDeliveryId: string | undefined;
  // Where the history of the deliveries the current line consumes goes: before their messages.
  let consumed: { readonly line: number | undefined; at: number } | undefined;
  const append = (message: TranscriptMessage) => {
    if (message.text.trim().length > 0) messages.push(message);
  };
  for (const event of events) {
    const line = event.meta?.position?.line;
    if (event.type !== "delivery.consumed" || consumed?.line !== line) consumed = undefined;
    switch (event.type) {
      case "delivery.admitted":
        if (
          event.data.source !== undefined &&
          "control" in event.data.source &&
          event.data.source.control === "reset"
        )
          resetDeliveryId = event.data.deliveryId;
        break;
      case "delivery.consumed": {
        consumed ??= { at: messages.length, line };
        const history = (event.data.history ?? [])
          .filter(({ text }) => text.trim().length > 0)
          .map(({ role, text }) => ({ role, text }));
        messages.splice(consumed.at, 0, ...history);
        consumed.at += history.length;
        append({ role: "user", text: textOf(event.data.parts) });
        break;
      }
      case "content.completed":
        if (
          event.data.kind === "text" &&
          event.data.phase === "reply" &&
          event.data.interrupted !== true &&
          typeof event.data.value === "string"
        )
          append({ role: "assistant", text: event.data.value });
        break;
      case "context.settled":
        if (event.data.selects === null) messages = [];
        break;
      case "session.ended":
        if (
          event.data.cause !== undefined &&
          "deliveryId" in event.data.cause &&
          event.data.cause.deliveryId === resetDeliveryId
        )
          messages = [];
        break;
    }
  }
  return { messages: maxMessages === undefined ? messages : messages.slice(-maxMessages) };
}

function textOf(parts: readonly UserPart[]): string {
  return parts.flatMap((part) => (part.kind === "text" ? [part.text] : [])).join("\n");
}
