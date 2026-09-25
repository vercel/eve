import {
  slackActionContextSchema,
  type SlackActionContext,
} from "#public/experimental/slack/action-context-schema.js";
import { contextStorage } from "#context/container.js";
import type { SessionAuthContext } from "#channel/types.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

/** Captures the receiving installation, not the caller's possibly different workspace. */
export function captureSlackActionContext(
  auth: SessionAuthContext | null,
): SlackActionContext | undefined {
  if (auth?.authenticator !== "slack-webhook" || auth.principalType !== "user") return undefined;
  const state = contextStorage.getStore()?.get(ChannelKey)?.state;
  const parsed = slackActionContextSchema.safeParse({
    installationTeamId: state?.installationTeamId,
    teamId: state?.teamId,
    userId: state?.triggeringUserId,
    channelId: state?.channelId,
    threadTs: state?.threadTs,
  });
  if (!parsed.success || !matchesSlackActionRequester(parsed.data, auth)) return undefined;
  return parsed.data;
}

export function matchesSlackActionRequester(
  origin: SlackActionContext,
  auth: SessionAuthContext,
): boolean {
  return (
    auth.authenticator === "slack-webhook" &&
    auth.principalType === "user" &&
    auth.issuer === `slack:${origin.teamId}` &&
    auth.principalId === `slack:${origin.teamId}:${origin.userId}` &&
    auth.attributes.team_id === origin.teamId &&
    auth.attributes.user_id === origin.userId &&
    auth.attributes.channel_id === origin.channelId &&
    auth.attributes.thread_ts === origin.threadTs
  );
}
