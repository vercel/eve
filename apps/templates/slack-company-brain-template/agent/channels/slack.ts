import type { SessionAuthContext } from "eve/context";
import {
  defaultSlackAuth,
  slackChannel,
  type SlackInboundMessageContext,
  type SlackMessage,
} from "eve/channels/slack";
import { isFullMember, isHomeTeam, slackCredentials, slackTeamId } from "../lib/slack.ts";

// Slack Connect events name the author's own workspace in `user_team` or
// `team`. Same-workspace events can omit both, and then the envelope's team is
// the author's.
function authorTeamId(message: SlackMessage): string | undefined {
  const { user_team: userTeam, team } = message.raw;
  if (typeof userTeam === "string") return userTeam;
  return typeof team === "string" ? team : message.teamId;
}

// WORKAROUND(vercel/eve#6088): copies Slack's per-message `action_token` into
// the turn's auth as the `action_token` attribute, where `tools/search_slack.ts`
// reads it. Once that PR ships in an eve release, `defaultSlackAuth` does this
// itself: bump `eve`, delete this function, and use `defaultSlackAuth(message, ctx)`
// directly in `admit`. The search tool needs no change.
function withActionToken(
  auth: SessionAuthContext | null,
  message: SlackMessage,
): SessionAuthContext | null {
  if (!auth || auth.attributes.action_token) return auth;
  const { action_token: topLevel, assistant_thread: assistantThread } = message.raw;
  // Slack nests the token under `assistant_thread` in app threads.
  const nested =
    typeof assistantThread === "object" && assistantThread !== null
      ? (assistantThread as Record<string, unknown>).action_token
      : undefined;
  const token = [topLevel, nested].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  if (!token) return auth;
  return { ...auth, attributes: { ...auth.attributes, action_token: token.trim() } };
}

// Fails closed: a lookup error drops the message or click instead of
// letting someone through unchecked.
async function canUseAgent(teamId: string | undefined, userId: string | undefined) {
  if (!teamId || !userId) return false;
  try {
    return await isFullMember(teamId, userId);
  } catch (error) {
    console.error("Slack member check failed", error);
    return false;
  }
}

async function admit(ctx: SlackInboundMessageContext, message: SlackMessage) {
  if (message.author?.isBot !== false) return null;
  if (!isHomeTeam(authorTeamId(message))) return null;
  const teamId = message.installationTeamId ?? message.teamId;
  if (!(await canUseAgent(teamId, message.author.userId))) return null;
  return { auth: withActionToken(defaultSlackAuth(message, ctx), message) };
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
  const admitted = await admit(ctx, message);
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
  // The same check for clicks, so guests can't answer approvals or questions
  // in a thread a member started.
  onAnswers: async (ctx) => {
    const userId = ctx.defaultAuth.attributes.user_id;
    const allowed = await canUseAgent(
      slackTeamId(ctx.defaultAuth),
      typeof userId === "string" ? userId : undefined,
    );
    return allowed ? { auth: ctx.defaultAuth } : null;
  },
});
