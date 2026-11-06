import {
  defaultSlackAuth,
  slackChannel,
  type SlackInboundMessageContext,
  type SlackMessage,
} from "eve/channels/slack";
import { isHomeTeam, slackCredentials } from "../lib/slack.ts";

function authorTeamId(message: SlackMessage): string | undefined {
  const { user_team: userTeam, team } = message.raw;
  if (typeof userTeam === "string") return userTeam;
  return typeof team === "string" ? team : undefined;
}

function admit(ctx: SlackInboundMessageContext, message: SlackMessage) {
  if (message.author?.isBot !== false) return null;
  if (!isHomeTeam(authorTeamId(message))) return null;
  return { auth: defaultSlackAuth(message, ctx) };
}

export default slackChannel({
  credentials: slackCredentials,
  // Each new mention also sees the thread replies posted since the agent last spoke.
  threadContext: { since: "last-agent-reply" },
  // Sender names let the agent say who asked what. Adds the `users:read` scope.
  messageContext: { users: true },
  onAppMention: admit,
  onDirectMessage: admit,
});
