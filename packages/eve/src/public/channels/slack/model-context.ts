import type { SlackThreadMessage } from "#public/channels/slack/api.js";
import type { SlackInboundContext } from "#public/channels/slack/inbound.js";
import { slackMrkdwnToGfm } from "#public/channels/slack/mrkdwn.js";
import type {
  SlackSenderProfile,
  SlackSenderProfiles,
} from "#public/channels/slack/sender-profiles.js";
import type { SessionHistoryMessage } from "#shared/session-history.js";

interface SlackModelMessageInput {
  readonly sender: {
    readonly type: "agent" | "bot" | "unknown" | "user";
    readonly id?: string;
    readonly profile?: SlackSenderProfile;
  };
  /** The receiving app; omitted for fetched thread replies. */
  readonly bot?: {
    readonly id?: string;
    readonly mentioned?: boolean;
  };
  readonly thread: {
    readonly teamId?: string;
    readonly channelId?: string;
    readonly threadTs: string;
    readonly messageTs: string;
  };
  readonly content: string;
}

/**
 * Renders one Slack message with its metadata grouped into `<sender>`,
 * `<bot>`, and `<thread>` blocks of the same model-visible message. Slack user
 * ids are stable, so they remain the canonical speaker identity; a looked-up
 * name and email only add to them.
 */
function formatSlackModelMessage({ sender, bot, thread, content }: SlackModelMessageInput): string {
  const botLines = [
    ...(bot?.id ? [`id: ${bot.id}`] : []),
    ...(bot?.mentioned !== undefined ? [`mentioned: ${bot.mentioned}`] : []),
  ];
  return [
    "<slack_message>",
    "<sender>",
    `type: ${sender.type}`,
    ...(sender.id ? [`id: ${sender.id}`] : []),
    ...(sender.profile?.name ? [`name: ${oneLine(sender.profile.name)}`] : []),
    ...(sender.profile?.email ? [`email: ${oneLine(sender.profile.email)}`] : []),
    "</sender>",
    ...(botLines.length > 0 ? ["<bot>", ...botLines, "</bot>"] : []),
    "<thread>",
    ...(thread.teamId ? [`team_id: ${thread.teamId}`] : []),
    ...(thread.channelId ? [`channel_id: ${thread.channelId}`] : []),
    `thread_ts: ${thread.threadTs}`,
    `message_ts: ${thread.messageTs}`,
    "</thread>",
    "<content>",
    content,
    "</content>",
    "</slack_message>",
  ].join("\n");
}

// A profile field is user-controlled; keep it from forging extra metadata lines.
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/gu, " ");
}

/** Renders the triggering inbound Slack message as one attributed block. */
export function formatSlackInboundMessage(
  context: SlackInboundContext,
  message: { readonly text: string; readonly ts: string },
  profiles?: SlackSenderProfiles,
): string {
  return formatSlackModelMessage({
    sender: {
      type: context.userId ? "user" : "unknown",
      id: context.userId || undefined,
      profile: context.userId ? profiles?.get(context.userId) : undefined,
    },
    bot: { id: context.botUserId, mentioned: context.isMentioned },
    thread: {
      teamId: context.teamId,
      channelId: context.channelId,
      threadTs: context.threadTs,
      messageTs: message.ts,
    },
    content: slackModelContent(message.text),
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
  profiles?: SlackSenderProfiles,
): string | undefined {
  if (messages.length === 0) return undefined;

  return [
    "<slack_thread_context>",
    ...messages.map((message) => formatSlackThreadMessage(message, profiles)),
    "</slack_thread_context>",
  ].join("\n");
}

function formatSlackThreadMessage(
  message: SlackThreadMessage,
  profiles: SlackSenderProfiles | undefined,
): string {
  return formatSlackModelMessage({
    sender: {
      type: slackThreadSenderType(message),
      id: message.user ?? message.botId,
      profile: message.user ? profiles?.get(message.user) : undefined,
    },
    thread: { threadTs: message.threadTs, messageTs: message.ts },
    content: message.markdown,
  });
}

function slackThreadSenderType(
  message: SlackThreadMessage,
): SlackModelMessageInput["sender"]["type"] {
  if (message.isMe) return "agent";
  if (message.botId) return "bot";
  if (message.user) return "user";
  return "unknown";
}

/**
 * Maps fetched thread replies to seeded session history. This app's own replies become assistant
 * turns; everyone else stays an attributed user message. Slack shows rendered output, so assistant
 * turns approximate what the model said.
 */
export function slackThreadSessionHistory(
  messages: readonly SlackThreadMessage[],
  profiles?: SlackSenderProfiles,
): SessionHistoryMessage[] {
  return messages.flatMap((message) => slackThreadHistoryMessage(message, profiles) ?? []);
}

function slackThreadHistoryMessage(
  message: SlackThreadMessage,
  profiles: SlackSenderProfiles | undefined,
): SessionHistoryMessage | undefined {
  if (message.markdown.trim().length === 0) return undefined;
  if (message.isMe) return { id: message.ts, role: "assistant", text: message.markdown };
  return {
    id: message.ts,
    role: "user",
    text: formatSlackThreadMessage(message, profiles),
  };
}
