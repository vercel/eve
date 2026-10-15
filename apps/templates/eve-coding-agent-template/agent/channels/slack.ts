import { connectSlackCredentials } from "@vercel/connect/eve";
import { defaultSlackAuth, slackChannel } from "eve/channels/slack";

import { allowlist } from "../lib/allowlist";

// Optional. Slack user IDs allowed to invoke the agent. Empty admits everyone.
const allowed = allowlist(process.env.SLACK_ALLOWED_USERS);

// `eve add channel/slack` creates or picks a Slack app and writes its
// connector UID here, so keep it a string literal.
export default slackChannel({
  credentials: connectSlackCredentials("slack/coding-agent"),
  onAppMention: (ctx, message) =>
    allowed(message.author?.userId) ? { auth: defaultSlackAuth(message, ctx) } : null,
  onDirectMessage: (ctx, message) =>
    allowed(message.author?.userId) ? { auth: defaultSlackAuth(message, ctx) } : null,
  // Approvals resume a parked turn, so they follow the same rule.
  onInputResponse: (ctx, submission) =>
    allowed(submission.user.id) ? { auth: ctx.defaultAuth } : null,
});
