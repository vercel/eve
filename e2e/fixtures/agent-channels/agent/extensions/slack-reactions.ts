import { isChannel } from "eve/channels";
import slackReactions from "eve/extensions/slack-reactions";

import teamChat from "../channels/team-chat";

export default slackReactions({
  scope(channel) {
    if (!isChannel(channel, teamChat)) return null;
    const { channelId, messageTs } = channel.metadata;
    return channelId === null ? null : { channelId, messageTs: messageTs ?? undefined };
  },
  credentials: { botToken: "xoxb-e2e" },
  // Every Slack call lands here and succeeds, so the eval needs no Slack workspace.
  api: { fetch: async () => Response.json({ ok: true }) },
});
