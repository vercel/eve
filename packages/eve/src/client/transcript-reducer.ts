import type { EveAgentReducer } from "#client/reducer.js";
import type { UserPart } from "#protocol/session-events/envelope.js";

/** One user message or completed assistant message in a {@link TranscriptData}. */
export interface TranscriptMessage {
  readonly role: "assistant" | "user";
  readonly text: string;
}

/** Text-only conversation projected by {@link transcriptReducer}. */
export interface TranscriptData {
  /** Messages since the session's last clear, oldest first. */
  readonly messages: readonly TranscriptMessage[];
}

/** Options for {@link transcriptReducer}. */
export interface TranscriptReducerOptions {
  /**
   * Most recent messages kept; older ones are dropped as new ones arrive.
   * A positive integer. Unbounded when omitted.
   */
  readonly maxMessages?: number;
}

/**
 * Creates a reducer that projects a session's stream into its text
 * conversation: user message text and completed assistant text, oldest
 * first.
 *
 * The user's text is what each consumed delivery carries; the assistant's is
 * each completed reply part. Reasoning, narration, tool calls and results,
 * attachments, interactions, and interrupted or unfinished output are left
 * out. A completed clear (`context.settled` selecting nothing), or a reset
 * that ended a stranded session, starts the transcript over, so text the
 * session no longer holds is never returned. Client projection events
 * such as optimistic submissions are ignored; the transcript reflects only
 * durable events.
 *
 * @example
 * ```ts
 * import { transcriptReducer } from "eve/client";
 * import { sessions } from "eve/server";
 *
 * const reducer = transcriptReducer({ maxMessages: 40 });
 * let transcript = reducer.initial();
 * for await (const event of sessions.attach(sessionId).stream({ follow: false })) {
 *   transcript = reducer.reduce(transcript, event);
 * }
 * ```
 *
 * @throws When `maxMessages` is not a positive integer.
 */
export function transcriptReducer(
  options: TranscriptReducerOptions = {},
): EveAgentReducer<TranscriptData> {
  const { maxMessages } = options;
  if (maxMessages !== undefined && (!Number.isSafeInteger(maxMessages) || maxMessages <= 0)) {
    throw new TypeError(
      `transcriptReducer: "maxMessages" must be a positive integer; received ${String(maxMessages)}.`,
    );
  }
  const append = (data: TranscriptData, message: TranscriptMessage): TranscriptData => {
    if (message.text.trim().length === 0) return data;
    const messages = [...data.messages, message];
    return {
      messages:
        maxMessages === undefined || messages.length <= maxMessages
          ? messages
          : messages.slice(-maxMessages),
    };
  };
  return {
    initial: () => ({ messages: [] }),
    reduce(data, event) {
      switch (event.type) {
        case "delivery.consumed":
          return append(data, { role: "user", text: textOf(event.data.parts) });
        case "content.completed":
          return event.data.kind === "text" &&
            event.data.phase === "reply" &&
            event.data.interrupted !== true &&
            typeof event.data.value === "string"
            ? append(data, { role: "assistant", text: event.data.value })
            : data;
        case "context.settled":
          return event.data.selects === null && data.messages.length > 0 ? { messages: [] } : data;
        case "session.ended":
          return event.data.cause !== undefined &&
            "policy" in event.data.cause &&
            event.data.cause.policy === "stranded-reset" &&
            data.messages.length > 0
            ? { messages: [] }
            : data;
        default:
          return data;
      }
    },
  };
}

function textOf(parts: readonly UserPart[]): string {
  return parts.flatMap((part) => (part.kind === "text" ? [part.text] : [])).join("\n");
}
