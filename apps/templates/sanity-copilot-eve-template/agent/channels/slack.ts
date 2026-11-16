import { connectSlackCredentials } from "@vercel/connect/eve";
import { slackChannel } from "eve/channels/slack";

/**
 * Slack channel: answers @mentions and DMs, replies in threads, and renders approvals as buttons.
 *
 * @remarks
 * Credentials are brokered by Vercel Connect through {@link connectSlackCredentials}, which
 * supplies both the outbound bot token and inbound webhook verification, so there are no Slack
 * secrets to manage in code. Create the connector with
 * `vercel connect create slack --name <name> --triggers`, then register this project's trigger
 * destination at `/eve/v1/slack`.
 *
 * @defaultValue The connector UID falls back to `"slack/sanity-copilot"` when
 * `SLACK_CONNECTOR` is unset.
 */
export default slackChannel({
  credentials: connectSlackCredentials(
    process.env.SLACK_CONNECTOR ?? "slack/sanity-copilot"
  ),
});
