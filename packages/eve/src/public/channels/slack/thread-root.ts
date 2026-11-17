import type { SlackChannelContext, SlackContext } from "#public/channels/slack/slackChannel.js";

export async function threadRootIsGone(channel: SlackContext): Promise<boolean> {
  const { channelId, codeChannel, threadTs } = channel.slack;
  if (!channelId || !threadTs || codeChannel) return false;
  if ((channel as Partial<SlackChannelContext>).state?.postedInThread === true) return false;
  try {
    const response = await channel.slack.request("chat.getPermalink", {
      channel: channelId,
      message_ts: threadTs,
    });
    return response.ok !== true && response.error === "message_not_found";
  } catch {
    return false;
  }
}
