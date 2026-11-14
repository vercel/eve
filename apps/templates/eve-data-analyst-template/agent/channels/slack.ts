import { runSqlApprovalCard } from "../lib/analyst/approval-card";
import { createSlackChannel } from "../lib/integrations/slack/channel";

/**
 * Connects the agent to Slack with identity context and the run_sql approval card.
 *
 * @remarks SLACK_AUTO_REPLY_CHANNEL_IDS optionally enables unsolicited top-level replies in selected channels.
 */
export default createSlackChannel({
  autoReplyChannelIds: (process.env.SLACK_AUTO_REPLY_CHANNEL_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
  inputRequests: runSqlApprovalCard,
});
