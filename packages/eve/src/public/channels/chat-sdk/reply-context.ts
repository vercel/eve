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
// Enough of the reply to pick it out when several messages share one turn.
const MAX_REPLY_CHARS = 200;

/**
 * Renders a `context` entry telling the model that the person's message is a
 * reply to an earlier message, and what that message said. Messaging apps show
 * the quote above the reply; without this the model sees only the reply.
 */
export function formatReplyContext(quoted: QuotedMessage, reply: string): string {
  const target = quoted.fromAgent === true ? "one of your earlier messages" : "an earlier message";
  const text = quoted.text === undefined ? undefined : neutralizeTags(quoted.text.trim());
  const replyText = neutralizeTags(reply.trim());
  const subject = replyText
    ? `The person's message ${JSON.stringify(truncate(replyText, MAX_REPLY_CHARS))}`
    : "The person's next message";
  return [
    "<reply_context>",
    `${subject} is a reply to ${target} (message_id: ${quoted.id}).`,
    ...(text
      ? ["<quoted_message>", truncate(text, MAX_QUOTED_CHARS), "</quoted_message>"]
      : ["The replied-to message's text is not available."]),
    "</reply_context>",
  ].join("\n");
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// Quoted text is written by people, so it must not be able to close this block
// and append text that reads as framework context.
function neutralizeTags(text: string): string {
  return text.replace(/<(\/?)(reply_context|quoted_message)/giu, "&lt;$1$2");
}
