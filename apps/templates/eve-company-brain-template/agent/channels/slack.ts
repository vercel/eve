import { connectSlackCredentials } from "@vercel/connect/eve";
import { defaultSlackAuth, slackChannel } from "eve/channels/slack";
import { canReadModels } from "../lib/access.ts";

export default slackChannel({
  credentials: connectSlackCredentials(process.env.SLACK_CONNECTOR ?? "slack/company-brain"),
  onAppMention(ctx, message) {
    const auth = defaultSlackAuth(message, ctx);
    return canReadModels(auth, process.env) ? { auth } : null;
  },
  onDirectMessage(ctx, message) {
    const auth = defaultSlackAuth(message, ctx);
    return canReadModels(auth, process.env) ? { auth } : null;
  },
  onInputResponse(ctx) {
    return canReadModels(ctx.defaultAuth, process.env) ? { auth: ctx.defaultAuth } : null;
  },
});
