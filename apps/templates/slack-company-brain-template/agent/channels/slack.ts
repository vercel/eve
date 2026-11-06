import { connectSlackCredentials } from "@vercel/connect/eve";
import {
  defaultSlackAuth,
  slackChannel,
  type SlackInboundMessageContext,
  type SlackMessage,
} from "eve/channels/slack";

// When SLACK_TEAM_ID is set, only members of that workspace can start a turn.
// Slack Connect channels can deliver messages from people in other companies,
// and a company brain usually should not answer them.
const homeTeamId = process.env.SLACK_TEAM_ID?.trim() || undefined;

function authorTeamId(message: SlackMessage): string | undefined {
  const { user_team: userTeam, team } = message.raw;
  if (typeof userTeam === "string") return userTeam;
  return typeof team === "string" ? team : undefined;
}

function admit(ctx: SlackInboundMessageContext, message: SlackMessage) {
  if (message.author?.isBot !== false) return null;
  if (homeTeamId && authorTeamId(message) !== homeTeamId) return null;
  return { auth: defaultSlackAuth(message, ctx) };
}

// SLACK_CONNECTOR is provisioned by `eve add channel/slack` or the "Deploy with
// Vercel" button. To create one yourself, run
// `vercel connect create slack --triggers` and put its UID in SLACK_CONNECTOR.
export default slackChannel({
  credentials: connectSlackCredentials(process.env.SLACK_CONNECTOR ?? "slack/company-brain"),
  // Each new mention also sees the thread replies posted since the agent last spoke.
  threadContext: { since: "last-agent-reply" },
  // Sender names let the agent say who asked what. Adds the `users:read` scope.
  messageContext: { users: true },
  onAppMention: admit,
  onDirectMessage: admit,
});
