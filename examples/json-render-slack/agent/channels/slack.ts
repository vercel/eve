import { slackChannel } from "eve/channels/slack";

// Reads SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET. With Vercel Connect, pass
// `credentials: connectSlackCredentials("slack/<connector>")` instead.
export default slackChannel({
  // Set only by `pnpm simulate`, which stands in for Slack's Web API locally.
  api: process.env.SLACK_API_BASE_URL ? { apiBaseUrl: process.env.SLACK_API_BASE_URL } : undefined,
});
