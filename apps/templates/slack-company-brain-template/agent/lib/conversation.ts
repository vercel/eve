import { isChannel } from "eve/channels";
import type { MemoryScopeContext } from "eve/memory";
import slack from "../channels/slack.ts";

export type Conversation =
  | { readonly kind: "private" }
  | { readonly kind: "slack-channel"; readonly teamId: string; readonly channelId: string };

/**
 * Classifies where the current session runs, from trusted channel metadata.
 * Slack DMs and non-Slack channels (such as eve's HTTP channel) are private.
 * Every other Slack conversation, including group DMs, is shared. Returns
 * `null` when a Slack session hasn't recorded its conversation.
 */
export function currentConversation(ctx: MemoryScopeContext): Conversation | null {
  if (!isChannel(ctx.channel, slack)) return { kind: "private" };
  const { channelId, teamId } = ctx.channel.metadata;
  if (!channelId || !teamId) return null;
  // Slack DM conversation IDs start with "D".
  if (channelId.startsWith("D")) return { kind: "private" };
  return { kind: "slack-channel", teamId, channelId };
}
