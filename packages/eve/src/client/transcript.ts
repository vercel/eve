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
 * A session's text conversation, from its stream: user message text and completed assistant
 * text, oldest first.
 *
 * The user's text is what each consumed delivery carries; the assistant's is each completed
 * reply part. Reasoning, narration, tool calls and results, attachments, interactions, and
 * interrupted or unfinished output are left out. A completed clear (`context.settled` selecting
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
  const append = (message: TranscriptMessage) => {
    if (message.text.trim().length > 0) messages.push(message);
  };
  for (const event of events) {
    switch (event.type) {
      case "delivery.consumed":
        append({ role: "user", text: textOf(event.data.parts) });
        break;
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
          "policy" in event.data.cause &&
          event.data.cause.policy === "stranded-reset"
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
