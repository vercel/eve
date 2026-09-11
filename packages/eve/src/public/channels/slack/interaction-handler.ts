import { createLogger } from "#internal/logging.js";
import { buildSlackWorkspaceHandle } from "#public/channels/slack/api.js";
import {
  isObjectRecord,
  readOptionalString,
  readSlackInteractionIdentity,
} from "#public/channels/slack/interaction-identity.js";
import type {
  SlackBlockActionsInteraction,
  SlackChannelConfig,
  SlackInteraction,
  SlackInteractionContext,
  SlackMessageInteractionContext,
} from "#public/channels/slack/slackChannel.js";

const log = createLogger("slack.interactions");

type InteractionHandler<TInteraction extends SlackInteraction> = (
  interaction: TInteraction,
  ctx: SlackInteractionContext,
) => void | Response | Promise<void | Response>;

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

  return invokeInteractionHandler({
    config,
    fallbackResponse,
    handler,
    interaction: buildInteraction(raw, fallbackType),
    message,
    waitUntil,
  });
}

export async function handleAuthoredBlockActions(input: {
  readonly config: SlackChannelConfig;
  readonly fallbackResponse: Response;
  readonly interaction: SlackBlockActionsInteraction;
  readonly message?: SlackMessageInteractionContext;
  readonly waitUntil: (task: Promise<unknown>) => void;
}): Promise<Response> {
  const handler = input.config.onBlockActions;
  if (handler === undefined) {
    return handleAuthoredInteraction(
      input.interaction.payload,
      input.interaction.type,
      input.waitUntil,
      input.config,
      input.fallbackResponse,
      input.message,
    );
  }
  return invokeInteractionHandler({ ...input, handler });
}

function buildInteraction(raw: Record<string, unknown>, fallbackType: string): SlackInteraction {
  const identity = readSlackInteractionIdentity(raw);
  return {
    type: readOptionalString(raw.type) ?? fallbackType,
    payload: raw,
    user: identity.user,
    teamId: identity.teamId,
    installationTeamId: identity.installationTeamId,
    enterpriseId: identity.enterpriseId,
  };
}

async function invokeInteractionHandler<TInteraction extends SlackInteraction>(input: {
  readonly config: SlackChannelConfig;
  readonly fallbackResponse: Response;
  readonly handler: InteractionHandler<TInteraction>;
  readonly interaction: TInteraction;
  readonly message?: SlackMessageInteractionContext;
  readonly waitUntil: (task: Promise<unknown>) => void;
}): Promise<Response> {
  const ctx: SlackInteractionContext = {
    slack: buildSlackWorkspaceHandle({
      botToken: input.config.credentials?.botToken,
      installationTeamId: input.interaction.installationTeamId,
      teamId: input.interaction.teamId,
    }),
    message: input.message,
    waitUntil: input.waitUntil,
  };
  try {
    return (await input.handler(input.interaction, ctx)) ?? new Response(null, { status: 200 });
  } catch (error) {
    log.error("interaction handler failed", { error });
    return input.fallbackResponse;
  }
}
