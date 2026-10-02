import type { SessionAuthContext } from "#channel/types.js";
import type { SlackChannelState } from "#public/channels/slack/slackChannel.js";

interface SlackAuthContextInput {
  readonly channelId: string;
  readonly fullName?: string;
  /** Workspace whose app installation received the event. Keys the principal when known. */
  readonly installationTeamId?: string | null;
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

/** Returns the Slack user recorded for a principal, if one has been seen in this thread. */
export function slackUserIdForPrincipal(
  state: Pick<SlackChannelState, "slackUsersByPrincipal">,
  principalId: string | undefined,
): string | undefined {
  return principalId === undefined ? undefined : state.slackUsersByPrincipal?.[principalId];
}

/**
 * Builds the Slack-derived session auth context used by inbound
 * messages and signed interactivity callbacks.
 */
export function buildSlackAuthContext(input: SlackAuthContextInput): SessionAuthContext {
  const isBot = input.isBot === true;
  // Messages and button clicks report different team fields for Slack Connect
  // and Enterprise Grid users. The installation team is the same on both, so
  // one person keeps one principal (and one connection grant) per thread.
  const identityTeamId = input.installationTeamId || input.teamId;
  const principalId = identityTeamId
    ? isBot
      ? `slack:${identityTeamId}:bot:${input.userId}`
      : `slack:${identityTeamId}:${input.userId}`
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
    issuer: identityTeamId ? `slack:${identityTeamId}` : "slack",
    principalId,
    principalType: isBot ? "service" : "user",
  };
}
