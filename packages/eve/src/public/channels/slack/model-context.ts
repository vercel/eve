import type { SlackThreadMessage } from "#public/channels/slack/api.js";
import type { SlackInboundContext } from "#public/channels/slack/inbound.js";

interface SlackModelMessageInput {
  readonly channelId?: string;
  readonly content: string;
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
export function formatSlackModelMessage(input: SlackModelMessageInput): string {
  return [
    "<slack_message>",
    `sender_type: ${input.senderType}`,
    ...(input.senderId ? [`sender_id: ${input.senderId}`] : []),
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
  message: { readonly markdown: string; readonly ts: string },
): string {
  return formatSlackModelMessage({
    channelId: context.channelId,
    content: message.markdown,
    senderId: context.userId || undefined,
    senderType: context.userId ? "user" : "unknown",
    teamId: context.teamId,
    threadTs: context.threadTs,
    ts: message.ts,
  });
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
