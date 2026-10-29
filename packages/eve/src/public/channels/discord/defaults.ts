import type { SessionAuthContext } from "#channel/types.js";

import { resolvedPromptLabel } from "#channel/resolved-prompt.js";
import type { Interaction, RequestSettlement } from "#channel/interaction-prompts.js";
import { postedIn, type SignInSurface } from "#channel/sign-in.js";
import { surfaceEvents } from "#channel/surface.js";
import { createLogger } from "#internal/logging.js";
import {
  DISCORD_MESSAGE_CONTENT_MAX_LENGTH,
  DISCORD_NO_MENTIONS,
  splitDiscordMessageContent,
} from "#public/channels/discord/api.js";
import type {
  DiscordCommandInteraction,
  DiscordInteractionBase,
  DiscordUser,
} from "#public/channels/discord/inbound.js";
import type {
  DiscordGatewayMessage,
  DiscordMessageResult,
} from "#public/channels/discord/messages.js";
import { renderInteractionComponents } from "#public/channels/discord/hitl.js";
import {
  renderDiscordAuthorizationPrompt,
  renderDiscordAuthorizationStatus,
} from "#public/channels/discord/authorization.js";
import type {
  DiscordChannelEvents,
  DiscordChannelState,
  DiscordCommandResult,
  DiscordContext,
  DiscordHandle,
  DiscordHitlPrompt,
} from "#public/channels/discord/discordChannel.js";

const log = createLogger("discord.defaults");

/**
 * Builds the default {@link SessionAuthContext} for the user behind a Discord
 * interaction (a command, button press, select, or modal submission):
 * authenticator `discord-interaction`, guild-scoped issuer/principalId when
 * invoked in a guild (else user-scoped), and `principalType` `service` for bot actors or
 * `user` otherwise. Copies the channel, interaction, user, guild, and
 * member-nick attributes. A message from the same person gets the same
 * principal from {@link defaultDiscordMessageAuth}.
 */
export function defaultDiscordAuth(interaction: DiscordInteractionBase): SessionAuthContext {
  const attributes: Record<string, string> = {
    channel_id: interaction.channelId,
    interaction_id: interaction.id,
  };
  if (interaction.member?.nick !== undefined) attributes.member_nick = interaction.member.nick;
  return discordUserAuth(interaction.user, interaction.guildId, attributes);
}

/**
 * Builds the default {@link SessionAuthContext} for the author of a Discord
 * message forwarded from the Gateway. The principal matches what
 * {@link defaultDiscordAuth} builds for the same person, so their button
 * presses answer approvals their messages asked for.
 */
export function defaultDiscordMessageAuth(message: DiscordGatewayMessage): SessionAuthContext {
  return discordUserAuth(message.author, message.guildId, {
    channel_id: message.channelId,
    message_id: message.id,
  });
}

function discordUserAuth(
  user: DiscordUser,
  guildId: string | undefined,
  attributes: Record<string, string>,
): SessionAuthContext {
  const allAttributes: Record<string, string> = {
    ...attributes,
    user_id: user.id,
    username: user.username,
  };
  if (guildId !== undefined) allAttributes.guild_id = guildId;
  return {
    attributes: allAttributes,
    // Shared by messages too, so changing it would orphan every existing Discord principal.
    authenticator: "discord-interaction",
    issuer: guildId ? `discord:${guildId}` : "discord",
    principalId: guildId ? `discord:${guildId}:${user.id}` : `discord:${user.id}`,
    principalType: user.isBot ? "service" : "user",
  };
}

/** Default command hook: dispatch with Discord user auth. */
export function defaultOnCommand(
  _ctx: DiscordContext,
  interaction: DiscordCommandInteraction,
): DiscordCommandResult {
  return { auth: defaultDiscordAuth(interaction) };
}

/**
 * Edits a posted prompt the way a resolved one reads: its prompt kept, its
 * choices replaced by `label`. Throws when Discord refuses the edit.
 */
export async function editDiscordResolvedPrompt(
  discord: Pick<DiscordHandle, "channelId" | "request">,
  prompt: Pick<DiscordHitlPrompt, "content" | "messageId">,
  label: string,
): Promise<void> {
  const content = `${prompt.content}\n\n${label}`.slice(0, DISCORD_MESSAGE_CONTENT_MAX_LENGTH);
  await editDiscordMessage(discord, prompt.messageId, content);
}

/**
 * Rewrites one of the bot's messages in the current channel to `content` and
 * removes its components. Throws when Discord refuses the edit.
 */
async function editDiscordMessage(
  discord: Pick<DiscordHandle, "channelId" | "request">,
  messageId: string,
  content: string,
): Promise<void> {
  // A raw request skips the API helpers' default, so suppress pings here.
  const response = await discord.request(
    `/channels/${encodeURIComponent(discord.channelId)}/messages/${encodeURIComponent(messageId)}`,
    { allowed_mentions: DISCORD_NO_MENTIONS, components: [], content },
    { botAuth: true, method: "PATCH" },
  );
  if (!response.ok) {
    throw new Error(`Discord message edit failed with HTTP ${response.status}.`);
  }
}

/** Default Gateway message hook: dispatch messages addressed to the bot with Discord user auth. */
export function defaultOnMessage(
  _ctx: DiscordContext,
  message: DiscordGatewayMessage,
): DiscordMessageResult {
  return message.addressed ? { auth: defaultDiscordMessageAuth(message) } : null;
}

type DiscordEventChannel = Parameters<
  NonNullable<DiscordChannelEvents["interaction.opened"]>
>[1]["channel"];

/**
 * Whether only the person signing in reads the conversation: a one-to-one DM (channel type 1),
 * from an interaction or a Gateway message. A group DM has no guild either, but every member
 * reads it. A session eve started itself records no channel type, so it isn't taken as private.
 */
export function signsInPrivately(state: DiscordChannelState): boolean {
  return state.channelType === 1;
}

/**
 * A Discord conversation as a sign-in shows on it: a DM gets the challenge; a group DM or server
 * channel, a link-free status whose button shows the challenge to its person alone.
 */
function discordSignIns(channel: DiscordEventChannel): SignInSurface {
  const { discord } = channel;
  const post = async (content: string) => (await discord.post({ content })).id || undefined;
  return {
    private: signsInPrivately(channel.state),
    postChallenge: async (signIn) =>
      (await discord.post(renderDiscordAuthorizationPrompt(signIn))).id || undefined,
    post,
    postStatus: async (signIn) =>
      (await discord.post(renderDiscordAuthorizationStatus(signIn))).id || undefined,
    async edit(messageId, content) {
      try {
        await editDiscordMessage(discord, messageId, content);
      } catch (error) {
        log.warn("Discord sign-in status edit failed", { error });
      }
    },
    typing: () => discord.startTyping(),
    posted: postedIn(channel.state, "pendingSignIns"),
  };
}

/** Built-in Discord event handlers for typing, replies, HITL, and terminal errors. */
export const defaultEvents: DiscordChannelEvents = surfaceEvents<DiscordEventChannel>({
  typing: (channel) => channel.discord.startTyping(),
  post: (channel, text) => channel.discord.post(text),
  restart: "command",
  requests: { show: postDiscordRequest, settle: editDiscordSettledRequest },
  signIns: discordSignIns,
});

async function postDiscordRequest(
  channel: DiscordEventChannel,
  request: Interaction,
): Promise<void> {
  const content = splitDiscordMessageContent(request.request.prompt)[0] ?? request.request.prompt;
  const components = renderInteractionComponents(request);
  const posted = await channel.discord.post({ components, content });
  if (components.length === 0 || !posted.id) return;
  channel.state.hitlPrompts = {
    ...channel.state.hitlPrompts,
    [request.interactionId]: {
      content,
      messageId: posted.id,
      options: (request.request.options ?? []).map(({ id, label }) => ({ id, label })),
    },
  };
}

/**
 * Shows a prompt's answer in place of its buttons. The bot token outlives the interaction token
 * the prompt may have been posted with.
 */
async function editDiscordSettledRequest(
  channel: DiscordEventChannel,
  settlement: RequestSettlement,
): Promise<void> {
  const { [settlement.interactionId]: prompt, ...rest } = channel.state.hitlPrompts ?? {};
  if (prompt === undefined) return;
  channel.state.hitlPrompts = rest;
  const label = resolvedPromptLabel(settlement, prompt.options);
  try {
    await editDiscordResolvedPrompt(channel.discord, prompt, label);
  } catch (error) {
    log.warn("Discord answered prompt edit failed", { error, requestId: settlement.interactionId });
  }
}
