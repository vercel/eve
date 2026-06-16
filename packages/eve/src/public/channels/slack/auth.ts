import type { SessionAuthContext } from "#channel/types.js";

interface SlackAuthContextInput {
  readonly channelId: string;
  readonly fullName?: string;
  readonly isBot?: boolean;
  readonly teamId?: string | null;
  readonly threadTs: string;
  readonly userId: string;
  readonly userName?: string;
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
