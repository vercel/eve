import { connectSlackCredentials } from "@vercel/connect/eve";
import { defaultSlackAuth, slackChannel } from "eve/channels/slack";

export default slackChannel({
  credentials: connectSlackCredentials("slack/my-agent"),
  async onMessage(ctx, message) {
    if (message.author?.isBot) return null;
    return (await ctx.isDMOrPrivateChannel()) || ctx.isBotMentioned() || (await ctx.isSubscribed())
      ? { auth: defaultSlackAuth(message, ctx) }
      : null;
  },
});
