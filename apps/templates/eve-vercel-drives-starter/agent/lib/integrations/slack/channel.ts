import { connectSlackCredentials } from "@vercel/connect/eve";
import { defaultSlackAuth, slackChannel } from "eve/channels/slack";
import type {
  SlackChannelConfig,
  SlackInboundMessageContext,
  SlackInboundResult,
  SlackMessage,
} from "eve/channels/slack";

import { requireEnv } from "../../utils/env";
import {
  createSlackIdentityResolver,
  formatSlackIdentityContext,
} from "./identity";

/**
 * Native Slack channel settings accepted by {@link createSlackChannel}.
 *
 * @remarks `credentials` is omitted because the channel reads them from the Vercel Connect connector named by `SLACK_CONNECTOR`.
 */
export type CreateSlackChannelConfig = Omit<SlackChannelConfig, "credentials">;

/** A defined `onMessage` handler, the shape {@link withIdentityContext} wraps. */
type InboundHandler = NonNullable<SlackChannelConfig["onMessage"]>;

/**
 * Starts a turn for a human-authored mention or DM using eve's Slack identity.
 *
 * @param ctx - Verified inbound webhook context supplied by eve.
 * @param message - Slack message carrying user, workspace, channel, and thread identifiers.
 * @returns eve's authenticated Slack principal, or null to drop the message.
 * @remarks Bots, the agent itself, and messages without a verified author are dropped, so no message falls back to a shared principal.
 */
export const handleExplicitInvocation = (
  ctx: SlackInboundMessageContext,
  message: SlackMessage
): SlackInboundResult => {
  if (message.author?.isMe === true || message.author?.isBot === true) {
    return null;
  }
  const auth = defaultSlackAuth(message, ctx);
  return auth ? { auth } : null;
};

/**
 * Chooses the mention, DM, and message handlers while preserving eve's handler precedence.
 *
 * @param handlers - Caller-supplied handlers, any of which may be omitted.
 * @returns The handlers to register.
 * @remarks Mentions and DMs default to {@link handleExplicitInvocation} only when the caller supplies no `onMessage`, because eve gives the specific handlers precedence over `onMessage`.
 */
export const selectInboundHandlers = ({
  onAppMention,
  onDirectMessage,
  onMessage,
}: Partial<
  Pick<SlackChannelConfig, "onAppMention" | "onDirectMessage" | "onMessage">
>) => {
  const fallback = onMessage ? undefined : handleExplicitInvocation;
  return {
    onAppMention: onAppMention ?? fallback,
    onDirectMessage: onDirectMessage ?? fallback,
    onMessage,
  };
};

/**
 * Wraps an inbound handler so accepted messages carry Slack profile context.
 *
 * @param handler - Handler that decides whether a message starts a turn.
 * @param resolveIdentities - Resolver for the sender, mentions, and thread participants.
 * @returns A handler that appends the identity block to any existing context, or undefined when no handler is given.
 */
export const withIdentityContext = (
  handler: SlackChannelConfig["onMessage"],
  resolveIdentities: ReturnType<typeof createSlackIdentityResolver>
): SlackChannelConfig["onMessage"] => {
  if (!handler) {
    return undefined;
  }
  const wrapped: InboundHandler = async (ctx, message) => {
    const result = await handler(ctx, message);
    if (!result) {
      return null;
    }
    const identities = await resolveIdentities(ctx, message);
    const identityContext = formatSlackIdentityContext(message, identities);
    return identityContext === undefined
      ? result
      : { ...result, context: [...(result.context ?? []), identityContext] };
  };
  return wrapped;
};

/**
 * Creates the Slack channel using credentials from the configured Vercel Connect connector.
 *
 * @param config - Native channel overrides.
 * @returns A channel definition whose inbound turns carry Slack profile context.
 * @throws {@link Error} When SLACK_CONNECTOR is missing.
 * @remarks Export this definition from agent/channels/slack.ts to retain the slack runtime name. Thread history defaults to messages since the agent's last reply.
 */
export const createSlackChannel = (config: CreateSlackChannelConfig = {}) => {
  const {
    onMessage,
    onAppMention,
    onDirectMessage,
    threadContext = { since: "last-agent-reply" },
    ...channelConfig
  } = config;
  const resolveIdentities = createSlackIdentityResolver(threadContext);
  const handlers = selectInboundHandlers({
    onAppMention,
    onDirectMessage,
    onMessage,
  });

  return slackChannel({
    ...channelConfig,
    credentials: connectSlackCredentials(
      requireEnv("SLACK_CONNECTOR", "slack/your-agent")
    ),
    onAppMention: withIdentityContext(handlers.onAppMention, resolveIdentities),
    onDirectMessage: withIdentityContext(
      handlers.onDirectMessage,
      resolveIdentities
    ),
    onMessage: withIdentityContext(handlers.onMessage, resolveIdentities),
    threadContext,
  });
};
