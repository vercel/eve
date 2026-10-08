import type { SlackThreadMessage } from "#public/channels/slack/api.js";
import type { SlackInboundContext } from "#public/channels/slack/inbound.js";
import { slackMrkdwnToGfm } from "#public/channels/slack/mrkdwn.js";
import {
  MAX_SESSION_HISTORY_CONTENT_BYTES,
  MAX_SESSION_HISTORY_MESSAGES,
  type SessionHistoryMessage,
  sessionHistoryContentBytes,
} from "#shared/session-history.js";

interface SlackModelMessageInput {
  readonly botUserId?: string;
  readonly channelId?: string;
  readonly content: string;
  readonly isMentioned?: boolean;
  readonly senderId?: string;
  readonly senderType: "agent" | "bot" | "unknown" | "user";
  readonly teamId?: string;
  readonly threadTs: string;
  readonly ts: string;
}

/**
 * Renders one Slack message with its sender identity attached to the same
 * model-visible message. Slack user ids are stable and require no profile
 * lookup, so they remain the canonical speaker identity.
 */
function formatSlackModelMessage(input: SlackModelMessageInput): string {
  return [
    "<slack_message>",
    `sender_type: ${input.senderType}`,
    ...(input.senderId ? [`sender_id: ${input.senderId}`] : []),
    ...(input.botUserId ? [`bot_user_id: ${input.botUserId}`] : []),
    ...(input.isMentioned !== undefined ? [`is_mentioned: ${input.isMentioned}`] : []),
    ...(input.channelId ? [`channel_id: ${input.channelId}`] : []),
    `thread_ts: ${input.threadTs}`,
    `message_ts: ${input.ts}`,
    ...(input.teamId ? [`team_id: ${input.teamId}`] : []),
    "<content>",
    input.content,
    "</content>",
    "</slack_message>",
  ].join("\n");
}

/** Renders the triggering inbound Slack message as one attributed block. */
export function formatSlackInboundMessage(
  context: SlackInboundContext,
  message: { readonly text: string; readonly ts: string },
): string {
  return formatSlackModelMessage({
    botUserId: context.botUserId,
    channelId: context.channelId,
    content: slackModelContent(message.text),
    isMentioned: context.isMentioned,
    senderId: context.userId || undefined,
    senderType: context.userId ? "user" : "unknown",
    teamId: context.teamId,
    threadTs: context.threadTs,
    ts: message.ts,
  });
}

function slackModelContent(input: string): string {
  const mentions: string[] = [];
  let markerPrefix = "\uE000eve_slack_user_mention_";
  while (input.includes(markerPrefix)) markerPrefix += "_";

  const protectedInput = input.replace(/<@[A-Z0-9_]+(?:\|[^>\r\n]+)?>/giu, (mention) => {
    const marker = `${markerPrefix}${mentions.length}\uE001`;
    mentions.push(mention);
    return marker;
  });
  let markdown = slackMrkdwnToGfm(protectedInput);
  for (const [index, mention] of mentions.entries()) {
    markdown = markdown.replaceAll(`${markerPrefix}${index}\uE001`, mention);
  }
  return markdown;
}

/**
 * Renders fetched Slack replies as explicitly attributed background context.
 * Returns `undefined` when there are no messages to add to the turn.
 */
export function formatSlackThreadContext(
  messages: readonly SlackThreadMessage[],
): string | undefined {
  if (messages.length === 0) return undefined;

  return [
    "<slack_thread_context>",
    ...messages.map((message) =>
      formatSlackModelMessage({
        content: message.markdown,
        senderId: message.user ?? message.botId,
        senderType: slackThreadSenderType(message),
        threadTs: message.threadTs,
        ts: message.ts,
      }),
    ),
    "</slack_thread_context>",
  ].join("\n");
}

function slackThreadSenderType(message: SlackThreadMessage): SlackModelMessageInput["senderType"] {
  if (message.isMe) return "agent";
  if (message.botId) return "bot";
  if (message.user) return "user";
  return "unknown";
}

/**
 * Maps fetched thread replies to seeded session history. This app's own replies become assistant
 * turns; everyone else stays an attributed user message. Slack shows rendered output, so assistant
 * turns approximate what the model said. The newest messages are kept when the thread exceeds the
 * history caps.
 */
export function slackThreadSessionHistory(
  messages: readonly SlackThreadMessage[],
): SessionHistoryMessage[] {
  const history: SessionHistoryMessage[] = [];
  let bytes = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (history.length === MAX_SESSION_HISTORY_MESSAGES) break;
    const entry = slackThreadHistoryMessage(messages[index]!);
    if (entry === undefined) continue;
    bytes += sessionHistoryContentBytes(entry);
    if (bytes > MAX_SESSION_HISTORY_CONTENT_BYTES) break;
    history.push(entry);
  }
  return history.reverse();
}

function slackThreadHistoryMessage(message: SlackThreadMessage): SessionHistoryMessage | undefined {
  if (message.markdown.trim().length === 0) return undefined;
  if (message.isMe) return { content: message.markdown, id: message.ts, role: "assistant" };
  return {
    content: formatSlackModelMessage({
      content: message.markdown,
      senderId: message.user ?? message.botId,
      senderType: slackThreadSenderType(message),
      threadTs: message.threadTs,
      ts: message.ts,
    }),
    id: message.ts,
    role: "user",
  };
}
