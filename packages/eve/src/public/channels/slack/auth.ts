import type { SessionAuthContext } from "#channel/types.js";
import type { SlackChannelState } from "#public/channels/slack/slackChannel.js";

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
 * Records which Slack user an input response's principal belongs to. Keyed by
 * principal so custom `onInputResponse` auth still resolves to the Slack user
 * who clicked.
 */
export function slackPrincipalUserPatch(
  auth: SessionAuthContext | null | undefined,
  slackUserId: string | null | undefined,
): Pick<SlackChannelState, "slackUsersByPrincipal"> | undefined {
  if (auth?.principalId === undefined || !slackUserId) return undefined;
  return { slackUsersByPrincipal: { [auth.principalId]: slackUserId } };
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
