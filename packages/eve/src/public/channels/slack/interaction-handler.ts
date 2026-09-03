import { createLogger } from "#internal/logging.js";
import { buildSlackWorkspaceHandle } from "#public/channels/slack/api.js";
import {
  isObjectRecord,
  readOptionalString,
  readSlackInteractionIdentity,
} from "#public/channels/slack/interaction-identity.js";
import type {
  SlackChannelConfig,
  SlackInteraction,
  SlackInteractionContext,
  SlackMessageInteractionContext,
} from "#public/channels/slack/slackChannel.js";

const log = createLogger("slack.interactions");

export async function handleAuthoredInteraction(
  raw: unknown,
  fallbackType: string,
  waitUntil: (task: Promise<unknown>) => void,
  config: SlackChannelConfig,
  fallbackResponse: Response,
  message?: SlackMessageInteractionContext,
): Promise<Response> {
  const handler = config.onInteraction;
  if (handler === undefined || !isObjectRecord(raw)) {
    log.warn("unsupported Slack interaction payload ignored", { type: fallbackType });
    return fallbackResponse;
  }

  const identity = readSlackInteractionIdentity(raw);
  const interaction: SlackInteraction = {
    type: readOptionalString(raw.type) ?? fallbackType,
    payload: raw,
    user: identity.user,
    teamId: identity.teamId,
    installationTeamId: identity.installationTeamId,
    enterpriseId: identity.enterpriseId,
  };
  const ctx: SlackInteractionContext = {
    slack: buildSlackWorkspaceHandle({
      botToken: config.credentials?.botToken,
      installationTeamId: identity.installationTeamId,
      teamId: identity.teamId,
    }),
    message,
    waitUntil,
  };

  try {
    return (await handler(interaction, ctx)) ?? new Response(null, { status: 200 });
  } catch (error) {
    log.error("interaction handler failed", { error });
    return fallbackResponse;
  }
}
