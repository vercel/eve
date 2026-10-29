import { slackChannel } from "eve/channels/slack";

export default slackChannel({
  credentials: {
    botToken: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
  },
});
