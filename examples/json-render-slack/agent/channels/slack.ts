import { slackChannel } from "eve/channels/slack";

import { slackCardRenderer } from "../lib/slack-card-renderer";

// Reads SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET. With Vercel Connect, pass
// `credentials: connectSlackCredentials("slack/<connector>")` and keep `renderers`.
export default slackChannel({
  renderers: [slackCardRenderer()],
});
