import type { SessionAuthContext } from "#channel/types.js";

import { resolvedPromptLabel } from "#channel/resolved-prompt.js";
import type { Interaction, RequestSettlement } from "#channel/interaction-prompts.js";
import { postedIn, signInChallengeText, type SignInSurface } from "#channel/sign-in.js";
import { surfaceEvents } from "#channel/surface.js";
import { createLogger } from "#internal/logging.js";
import {
  DISCORD_MESSAGE_CONTENT_MAX_LENGTH,
  splitDiscordMessageContent,
} from "#public/channels/discord/api.js";
import type {
  DiscordCommandInteraction,
  DiscordInteractionBase,
} from "#public/channels/discord/inbound.js";
import { renderInteractionComponents } from "#public/channels/discord/hitl.js";
import type {
  DiscordChannelEvents,
  DiscordChannelState,
  DiscordCommandResult,
  DiscordContext,
} from "#public/channels/discord/discordChannel.js";

const log = createLogger("discord.defaults");

/**
 * Builds the default {@link SessionAuthContext} for the user behind a Discord
 * interaction (a command, button press, select, or modal submission):
 * authenticator `discord-interaction`, guild-scoped issuer/principalId when
 * invoked in a guild (else user-scoped), and `principalType` `service` for bot
 * actors or `user` otherwise. Copies the channel, interaction, user, guild,
 * and member-nick attributes.
 */
export function defaultDiscordAuth(interaction: DiscordInteractionBase): SessionAuthContext {
  const attributes: Record<string, string> = {
    channel_id: interaction.channelId,
    interaction_id: interaction.id,
    user_id: interaction.user.id,
    username: interaction.user.username,
  };
  if (interaction.guildId !== undefined) attributes.guild_id = interaction.guildId;
  if (interaction.member?.nick !== undefined) attributes.member_nick = interaction.member.nick;

  const issuer = interaction.guildId ? `discord:${interaction.guildId}` : "discord";
  const principalId = interaction.guildId
    ? `discord:${interaction.guildId}:${interaction.user.id}`
    : `discord:${interaction.user.id}`;

  return {
    attributes,
    authenticator: "discord-interaction",
    issuer,
    principalId,
    principalType: interaction.user.isBot ? "service" : "user",
  };
}

/** Default command hook: dispatch with Discord user auth. */
export function defaultOnCommand(
  _ctx: DiscordContext,
  interaction: DiscordCommandInteraction,
): DiscordCommandResult {
  return { auth: defaultDiscordAuth(interaction) };
}

type DiscordEventChannel = Parameters<
  NonNullable<DiscordChannelEvents["interaction.opened"]>
>[1]["channel"];

/**
 * Whether only the person signing in reads the conversation: a one-to-one DM (channel type 1).
 * A group DM has no guild either, but every member reads it. A session eve started itself has no
 * interaction, so it isn't taken as private.
 */
export function signsInPrivately(state: DiscordChannelState): boolean {
  return state.channelType === 1 && state.interactionToken !== null;
}

/**
 * A Discord conversation as a sign-in shows on it: a DM gets the challenge; a group DM or server
 * channel, a link-free status that points to a DM.
 */
function discordSignIns(channel: DiscordEventChannel): SignInSurface {
  const { discord } = channel;
  const post = async (content: string) => (await discord.post({ content })).id || undefined;
  return {
    private: signsInPrivately(channel.state),
    postChallenge: (signIn) => post(signInChallengeText(signIn)),
    post,
    async edit(messageId, content) {
      try {
        const response = await discord.request(
          `/channels/${encodeURIComponent(discord.channelId)}/messages/${encodeURIComponent(messageId)}`,
          { content },
          { botAuth: true, method: "PATCH" },
        );
        if (!response.ok)
          log.warn("Discord sign-in status edit failed", { status: response.status });
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
  const content = `${prompt.content}\n\n${label}`.slice(0, DISCORD_MESSAGE_CONTENT_MAX_LENGTH);
  const path = `/channels/${encodeURIComponent(channel.discord.channelId)}/messages/${encodeURIComponent(prompt.messageId)}`;
  try {
    const response = await channel.discord.request(
      path,
      { components: [], content },
      { botAuth: true, method: "PATCH" },
    );
    if (!response.ok) {
      log.warn("Discord answered prompt edit failed", {
        requestId: settlement.interactionId,
        status: response.status,
      });
    }
  } catch (error) {
    log.warn("Discord answered prompt edit failed", { error, requestId: settlement.interactionId });
  }
}
