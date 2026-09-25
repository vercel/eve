import { connectSlackCredentials } from "@vercel/connect/eve";
import { defaultSlackAuth, slackChannel } from "eve/channels/slack";

import { shouldRespond } from "#lib/decisions.js";

export default slackChannel({
  credentials: connectSlackCredentials(process.env.SLACK_CONNECTOR ?? "slack/my-agent"),
  async onMessage(ctx, message) {
    if (message.author?.isBot) return null;

    const isMentioned = ctx.isBotMentioned();
    const isSubscribed = await ctx.isSubscribed();
    if (
      !isMentioned &&
      !isSubscribed &&
      !(await shouldRespond({
        message: message.text,
        isMentioned,
        isSubscribed,
      }))
    ) {
      return null;
    }

    return { auth: defaultSlackAuth(message, ctx) };
  },
});
