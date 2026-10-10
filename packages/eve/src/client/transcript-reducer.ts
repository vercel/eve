import type { EveAgentReducer, EveAgentReducerEvent } from "#client/reducer.js";

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
 * Reasoning, tool calls and results, attachments, approvals, and assistant
 * output that never completed are left out. A `context.cleared` event, or a
 * reset that ended a stranded session, starts the transcript over, so text
 * the session no longer holds is never returned. Client projection events
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
        case "message.received":
          return append(data, { role: "user", text: receivedText(event) });
        case "message.completed":
          return append(data, { role: "assistant", text: event.data.message });
        case "context.cleared":
          return data.messages.length === 0 ? data : { messages: [] };
        case "session.failed":
          return event.data.code === "session_stranded" &&
            event.data.details?.trigger === "reset" &&
            data.messages.length > 0
            ? { messages: [] }
            : data;
        default:
          return data;
      }
    },
  };
}

function receivedText(event: Extract<EveAgentReducerEvent, { type: "message.received" }>): string {
  const { message, parts } = event.data;
  if (parts === undefined) return message;
  return parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}
