import { connectSlackCredentials } from "@vercel/connect/eve";
import {
  defaultSlackAuth,
  loadThreadContextMessages,
  slackChannel,
  type SlackContext,
  type SlackMessage,
} from "eve/channels/slack";
import { buildAppSessionAuth } from "../../shared/slack-auth";
import {
  consumeSlackLinkCodeRemote,
  fetchSlackLinkForMember,
  parseSlackLinkCommand,
} from "../lib/slack-internal";

async function slackUserProfile(ctx: SlackContext, userId: string) {
  const res = await ctx.slack.request("users.info", { user: userId });
  if (!res.ok || typeof res.user !== "object" || res.user === null) return null;

  const user = res.user as {
    name?: string;
    real_name?: string;
    profile?: { display_name?: string; real_name?: string; email?: string };
  };

  const displayName =
    user.profile?.display_name?.trim() ||
    user.profile?.real_name?.trim() ||
    user.real_name?.trim() ||
    user.name;

  return {
    userId,
    userName: user.name,
    displayName,
    email: user.profile?.email,
  };
}

async function tryHandleSlackLinkCommand(ctx: SlackContext, message: SlackMessage) {
  const userId = message.author?.userId;
  const teamId = message.teamId;
  const text = message.markdown ?? message.text ?? "";

  if (!userId || !teamId) {
    return false;
  }

  const code = parseSlackLinkCommand(text);
  if (!code) {
    return false;
  }

  const profile = await slackUserProfile(ctx, userId);
  const result = await consumeSlackLinkCodeRemote({
    code,
    slackTeamId: teamId,
    slackUserId: userId,
    slackUserName: profile?.userName ?? message.author?.userName,
    slackDisplayName: profile?.displayName ?? message.author?.fullName,
    slackEmail: profile?.email,
  });

  if (result.ok) {
    await ctx.thread.post(
      "Your Slack account is now linked to V. Mentions and DMs will use your profile and integrations.",
    );
    return true;
  }

  const reason =
    result.reason === "expired"
      ? "That link code has expired. Generate a new one in V → Integrations."
      : "That link code is invalid. Generate a fresh code in V → Integrations.";

  await ctx.thread.post(reason);
  return true;
}

async function resolveSlackInboundAuth(
  slackAuth: ReturnType<typeof defaultSlackAuth>,
  member: {
    teamId?: string | null;
    userId: string;
    userName?: string;
    displayName?: string;
    email?: string;
  },
) {
  if (!member.teamId) {
    return slackAuth;
  }

  const link = await fetchSlackLinkForMember(member.teamId, member.userId);
  if (!link) {
    return slackAuth;
  }

  return buildAppSessionAuth(link.appUserId, {
    email: member.email ?? link.slackEmail,
    name: member.displayName ?? link.slackDisplayName,
    slack_team_id: member.teamId,
    slack_user_id: member.userId,
    slack_user_name: member.userName ?? link.slackUserName,
    linked: "true",
  });
}

async function buildSlackTurn(ctx: SlackContext, message: SlackMessage) {
  if (await tryHandleSlackLinkCommand(ctx, message)) {
    return null;
  }

  await ctx.thread.startTyping("Thinking…");

  const context: string[] = [];
  const userId = message.author?.userId;
  let profile: Awaited<ReturnType<typeof slackUserProfile>> = null;

  if (userId) {
    profile = await slackUserProfile(ctx, userId);
    if (profile?.displayName) {
      context.push(
        [
          "Slack user speaking in this thread:",
          `- Display name: ${profile.displayName}`,
          profile.userName ? `- Username: @${profile.userName}` : null,
          `- User ID: ${profile.userId}`,
          profile.email ? `- Email: ${profile.email}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
  }

  const prior = await loadThreadContextMessages(ctx.thread, message, {
    since: "last-agent-reply",
  });
  if (prior.length > 0) {
    const transcript = prior
      .map((m) => `${m.isMe ? "V" : (m.user ?? "user")}: ${m.markdown}`)
      .join("\n");
    context.push(`Recent thread messages since your last reply:\n\n${transcript}`);
  }

  const slackAuth = defaultSlackAuth(message, ctx);
  if (!slackAuth || !userId) {
    return null;
  }

  const auth = await resolveSlackInboundAuth(slackAuth, {
    teamId: message.teamId,
    userId,
    userName: profile?.userName ?? message.author?.userName,
    displayName: profile?.displayName ?? message.author?.fullName,
    email: profile?.email,
  });

  const linked = auth.principalId !== slackAuth.principalId;
  if (!linked) {
    const linkUrl = process.env.BETTER_AUTH_URL
      ? `${process.env.BETTER_AUTH_URL.replace(/\/$/, "")}/settings/integrations`
      : "V → Integrations";
    context.push(
      `This Slack account is not linked to a V profile yet. Open ${linkUrl}, generate a link code, then message \`link <code>\` here.`,
    );
  }

  return {
    auth,
    context: context.length > 0 ? context : undefined,
  };
}

// Replace with your Vercel Connect Slack slug (e.g. "slack/your-agent").
export default slackChannel({
  credentials: connectSlackCredentials("slack/v"),

  async onAppMention(ctx, message) {
    return buildSlackTurn(ctx, message);
  },

  async onDirectMessage(ctx, message) {
    return buildSlackTurn(ctx, message);
  },
});
