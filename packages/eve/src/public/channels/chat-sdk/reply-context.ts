/** What a channel knows about the earlier message a person replied to. */
export interface QuotedMessage {
  /** Platform id of the replied-to message. */
  readonly id: string;
  /** Text of the replied-to message, when the platform supplies it. */
  readonly text?: string;
  /** Whether the agent sent the replied-to message, when the platform says. */
  readonly fromAgent?: boolean;
}

// A reply can quote a long agent answer; the model needs enough to know which one.
const MAX_QUOTED_CHARS = 1000;

/**
 * Renders a `context` entry telling the model that the person's message is a
 * reply to an earlier message, and what that message said. Messaging apps show
 * the quote above the reply; without this the model sees only the reply.
 */
export function formatReplyContext(quoted: QuotedMessage): string {
  const target = quoted.fromAgent === true ? "one of your earlier messages" : "an earlier message";
  const text = quoted.text?.trim();
  return [
    "<reply_context>",
    `The person's next message is a reply to ${target} (message_id: ${quoted.id}).`,
    ...(text
      ? ["<quoted_message>", truncate(text), "</quoted_message>"]
      : ["The replied-to message's text is not available."]),
    "</reply_context>",
  ].join("\n");
}

function truncate(text: string): string {
  return text.length > MAX_QUOTED_CHARS ? `${text.slice(0, MAX_QUOTED_CHARS)}…` : text;
}
