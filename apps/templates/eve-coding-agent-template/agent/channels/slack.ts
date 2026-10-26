import { connectSlackCredentials } from "@vercel/connect/eve";
import { slackChannel } from "eve/channels/slack";

// `eve add channel/slack` creates or picks a Slack app and writes its
// connector UID here, so keep it a string literal.
export default slackChannel({
  credentials: connectSlackCredentials("slack/coding-agent"),
});
