import type { SessionAuthContext } from "#channel/types.js";

import { extractErrorId, formatErrorHint } from "#internal/logging.js";
import { splitDiscordMessageContent } from "#public/channels/discord/api.js";
import type { DiscordCommandInteraction } from "#public/channels/discord/inbound.js";
import { renderInputRequestComponents } from "#public/channels/discord/hitl.js";
import type {
  DiscordChannelEvents,
  DiscordCommandResult,
  DiscordContext,
} from "#public/channels/discord/discordChannel.js";

/**
 * Builds the default {@link SessionAuthContext} for a Discord command
 * interaction: authenticator `discord-interaction`, guild-scoped
 * issuer/principalId when invoked in a guild (else user-scoped), and
 * `principalType` `service` for bot actors or `user` otherwise. Copies the
 * channel, interaction, user, guild, and member-nick attributes.
 */
export function defaultDiscordAuth(interaction: DiscordCommandInteraction): SessionAuthContext {
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

/** Built-in Discord event handlers for typing, replies, HITL, and terminal errors. */
export const defaultEvents: DiscordChannelEvents = {
  async "turn.started"(_event, channel, _ctx) {
    await channel.discord.startTyping();
  },

  async "actions.requested"(_event, channel, _ctx) {
    await channel.discord.startTyping();
  },

  async "input.requested"(event, channel, _ctx) {
    for (const request of event.requests) {
      const content = splitDiscordMessageContent(request.prompt)[0] ?? request.prompt;
      await channel.discord.post({
        components: renderInputRequestComponents(request),
        content,
      });
    }
  },

  async "message.completed"(event, channel, _ctx) {
    if (event.finishReason === "tool-calls" || !event.message) return;
    await channel.discord.post(event.message);
  },

  async "session.failed"(event, channel) {
    const hint = formatErrorHint(event);
    const errorId = extractErrorId(event.details);
    await channel.discord.post(
      [
        `This session could not recover from an error${hint}.`,
        "",
        "Start a new command to continue.",
        ...(errorId ? ["", `Error id: ${errorId}`] : []),
      ].join("\n"),
    );
  },

  async "turn.failed"(event, channel, _ctx) {
    const hint = formatErrorHint(event);
    const errorId = extractErrorId(event.details);
    await channel.discord.post(
      [
        `I hit an error while handling your request${hint}.`,
        "",
        "Please try again, rephrase, or reach out if it keeps failing.",
        ...(errorId ? ["", `Error id: ${errorId}`] : []),
      ].join("\n"),
    );
  },
};
