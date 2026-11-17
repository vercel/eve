export interface QuotedMessage {
  readonly id: string;
  readonly text?: string;
  readonly fromAgent?: boolean;
}

const MAX_QUOTED_CHARS = 1000;
const MAX_REPLY_CHARS = 200;

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

function neutralizeTags(text: string): string {
  return text.replace(/<(\/?)(reply_context|quoted_message)/giu, "&lt;$1$2");
}
