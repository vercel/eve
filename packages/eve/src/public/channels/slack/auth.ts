import type { SessionAuthContext } from "#channel/types.js";
import { createLogger } from "#internal/logging.js";
import { callSlackApi, resolveSlackBotToken } from "#public/channels/slack/api.js";
import type { SlackChannelConfig } from "#public/channels/slack/slackChannel.js";
import { isObject } from "#shared/guards.js";

const log = createLogger("slack.auth");

/**
 * Outsiders include both workspace guests and external Slack Connect members.
 * A signed webhook authenticates Slack, not membership in the bot's workspace.
 */
export async function admitSlackUser(input: {
  readonly config: SlackChannelConfig;
  readonly installationTeamId: string | undefined;
  readonly userId: unknown;
}): Promise<boolean> {
  if (input.config.excludeOutsiders !== true) return true;
  if (typeof input.userId !== "string" || input.userId.length === 0) return false;

  try {
    const botToken = await resolveSlackBotToken(input.config.credentials?.botToken, {
      teamId: input.installationTeamId,
    });
    // The event's team can be the actor's workspace. Anchor membership to the
    // actual bot token instead, including when webhook installation metadata is absent.
    const installation = await callSlackApi({ botToken, operation: "auth.test", body: {} });
    const teamId = installation.team_id;
    if (installation.ok !== true || typeof teamId !== "string" || teamId.length === 0) {
      log.warn("Slack member verification failed: auth.test must identify a workspace");
      return false;
    }
    const response = await callSlackApi({
      botToken,
      operation: "users.info",
      body: { user: input.userId },
    });
    if (response.ok !== true || !isObject(response.user)) {
      log.warn("Slack member verification failed: check the bot token and users:read scope");
      return false;
    }
    const user = response.user;
    const enterpriseTeams = isObject(user.enterprise_user) ? user.enterprise_user.teams : undefined;
    const isMember =
      user.team_id === teamId ||
      (Array.isArray(enterpriseTeams) && enterpriseTeams.includes(teamId));
    return (
      user.id === input.userId &&
      isMember &&
      user.is_restricted === false &&
      user.is_ultra_restricted === false &&
      user.is_external !== true &&
      user.is_stranger !== true &&
      user.deleted !== true &&
      user.is_bot !== true
    );
  } catch {
    log.warn("Slack member verification failed: check Slack connectivity and bot credentials");
    return false;
  }
}

interface SlackAuthContextInput {
  readonly channelId: string;
  readonly fullName?: string;
  readonly isBot?: boolean;
  readonly teamId?: string | null;
  readonly threadTs: string;
  readonly userId: string;
  readonly userName?: string;
}

/** Returns the Slack user id carried by a Slack-derived auth context. */
export function slackUserIdFromAuthContext(auth: SessionAuthContext | null): string | undefined {
  if (auth?.authenticator !== "slack-webhook") return undefined;
  const userId = auth.attributes.user_id;
  return typeof userId === "string" && userId.length > 0 ? userId : undefined;
}

/**
 * Builds the Slack-derived session auth context used by inbound
 * messages and signed interactivity callbacks.
 */
export function buildSlackAuthContext(input: SlackAuthContextInput): SessionAuthContext {
  const isBot = input.isBot === true;
  const principalId = input.teamId
    ? isBot
      ? `slack:${input.teamId}:bot:${input.userId}`
      : `slack:${input.teamId}:${input.userId}`
    : isBot
      ? `slack:bot:${input.userId}`
      : `slack:${input.userId}`;

  const attributes: Record<string, string> = {
    author_type: isBot ? "bot" : "user",
    channel_id: input.channelId,
    thread_ts: input.threadTs,
    user_id: input.userId,
  };
  if (input.userName) attributes.user_name = input.userName;
  if (input.fullName) attributes.full_name = input.fullName;
  if (input.teamId) attributes.team_id = input.teamId;

  return {
    attributes,
    authenticator: "slack-webhook",
    issuer: input.teamId ? `slack:${input.teamId}` : "slack",
    principalId,
    principalType: isBot ? "service" : "user",
  };
}
