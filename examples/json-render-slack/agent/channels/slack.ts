import { slackChannel } from "eve/channels/slack";

// Reads SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET. With Vercel Connect, pass
// `credentials: connectSlackCredentials("slack/<connector>")` instead.
export default slackChannel();
