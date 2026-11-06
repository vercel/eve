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

const FOLLOWED_THREAD_GUIDANCE =
  "You are part of this Slack thread, so you see replies people send each other. This reply " +
  "doesn't mention you. Answer only if it's meant for you or you can clearly help; otherwise " +
  "call `no_reply`.";

// Replies without a mention in a thread the agent is already part of. Top-level
// messages still need a mention, so the agent only follows threads it was
// brought into. Needs the `message.channels` event and `channels:history` scope
// (plus `message.groups` and `groups:history` for private channels).
async function followThread(ctx: SlackInboundMessageContext, message: SlackMessage) {
  // An edit only reaches a thread that already has a session.
  const followed =
    ctx.edit !== undefined || (message.threadTs !== message.ts && (await ctx.isSubscribed()));
  if (!followed) return null;
  const admitted = admit(ctx, message);
  return (
    admitted && { ...admitted, status: "deferred" as const, guidance: FOLLOWED_THREAD_GUIDANCE }
  );
}

export default slackChannel({
  credentials: slackCredentials,
  // Each new mention also sees the thread replies posted since the agent last spoke.
  threadContext: { since: "last-agent-reply" },
  // Sender names let the agent say who asked what. Adds the `users:read` scope.
  messageContext: { users: true },
  onAppMention: admit,
  onDirectMessage: admit,
  onMessage: followThread,
});
