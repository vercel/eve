import type { SessionAuthContext } from "#channel/types.js";

import { extractErrorId, formatErrorHint } from "#internal/logging.js";
import { DISCORD_NO_MENTIONS, splitDiscordMessageContent } from "#public/channels/discord/api.js";
import type {
  DiscordCommandInteraction,
  DiscordInteraction,
} from "#public/channels/discord/inbound.js";
import { renderInputRequestComponents } from "#public/channels/discord/hitl.js";
import type {
  DiscordChannelEvents,
  DiscordEventContext,
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
export function defaultDiscordAuth(interaction: DiscordInteraction): SessionAuthContext {
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
function discordHitlContinuationKey(channel: DiscordEventContext): string | undefined {
  if (channel.continuation === undefined) return undefined;
  const existing = channel.state.hitlContinuationKey;
  if (existing !== undefined) return existing;
  const key = `h${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  channel.continuation.rekey(`${channel.discord.channelId}:${key}`);
  channel.state.hitlContinuationKey = key;
  return key;
}

export const defaultEvents: DiscordChannelEvents = {
  async "turn.started"(_event, channel, _ctx) {
    await channel.discord.startTyping();
  },

  async "authorization.completed"(event, channel, _ctx) {
    if (event.outcome === "authorized") {
      await channel.discord.startTyping();
    }
  },

  async "actions.requested"(_event, channel, _ctx) {
    await channel.discord.startTyping();
  },

  async "input.requested"(event, channel, _ctx) {
    const continuationKey = discordHitlContinuationKey(channel);
    for (const request of event.requests) {
      const content = splitDiscordMessageContent(request.prompt)[0] ?? request.prompt;
      const posted = await channel.discord.post({
        components: renderInputRequestComponents(request, { continuationKey }),
        content,
      });
      if (request.kind === "tool-approval" && posted.id) {
        channel.state.pendingApprovalMessages = {
          ...channel.state.pendingApprovalMessages,
          [request.requestId]: {
            channelId: posted.channelId ?? channel.discord.channelId,
            messageId: posted.id,
          },
        };
      }
    }
  },

  async "approval.settled"(event, channel, _ctx) {
    const messages = channel.state.pendingApprovalMessages ?? {};
    const message = messages[event.requestId];
    if (message === undefined) return;
    const label = event.outcome === "approved" ? "Approved" : "Cancelled";
    const userId = channel.state.approvalResponderUsers?.[event.responderPrincipalId];
    const response = await channel.discord.request(
      `/channels/${encodeURIComponent(message.channelId)}/messages/${encodeURIComponent(message.messageId)}`,
      {
        allowed_mentions: DISCORD_NO_MENTIONS,
        components: [],
        content: userId === undefined ? label : `${label} by <@${userId}>`,
      },
      { botAuth: true, method: "PATCH" },
    );
    if (!response.ok) {
      throw new Error(`Discord approval message update failed with HTTP ${response.status}.`);
    }
    const next = { ...messages };
    delete next[event.requestId];
    channel.state.pendingApprovalMessages = next;
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
