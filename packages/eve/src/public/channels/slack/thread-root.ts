import type { SlackChannelContext, SlackContext } from "#public/channels/slack/slackChannel.js";

/**
 * True when the bound thread's root message no longer exists. Slack accepts
 * a `thread_ts` whose parent is gone and posts the message at the top level
 * of the channel, so a reply to a deleted root would leak into the channel.
 *
 * `chat.getPermalink` needs no scopes, unlike `conversations.replies`, so
 * the check works with the minimal `app_mentions:read` + `chat:write` app.
 * Only `message_not_found` counts as gone. Any other failure to look it up
 * counts as "not gone", so a lookup problem never swallows a reply.
 *
 * Once eve has posted in the thread, deleting the root leaves a tombstone
 * that keeps the thread, and `chat.getPermalink` may not tell a tombstone
 * from a missing message, so the check is skipped.
 */
export async function threadRootIsGone(channel: SlackContext): Promise<boolean> {
  const { channelId, codeChannel, threadTs } = channel.slack;
  // A code channel has no session root, and a reply that lands top-level stays in the channel.
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
