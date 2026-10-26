import type { SessionAuthContext } from "#channel/types.js";

import { resolvedPromptLabel } from "#channel/resolved-prompt.js";
import { createLogger, extractErrorId, formatErrorHint } from "#internal/logging.js";
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
import { renderInputRequestComponents } from "#public/channels/discord/hitl.js";
import {
  discordAuthorizationMessageKey,
  renderDiscordAuthorizationCompleted,
  renderDiscordAuthorizationPrompt,
  renderDiscordAuthorizationStatus,
} from "#public/channels/discord/authorization.js";
import type {
  DiscordChannelEvents,
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

/** Built-in Discord event handlers for typing, replies, HITL, and terminal errors. */
export const defaultEvents: DiscordChannelEvents = {
  async "turn.started"(_event, channel, _ctx) {
    await channel.discord.startTyping();
  },

  // In a 1:1 DM the person signing in is the only one there, so the link goes in the open.
  // Anywhere else, including group DMs and proactive sessions, the button keeps it private.
  async "authorization.required"(event, channel, _ctx) {
    const message =
      channel.state.directMessage === true
        ? renderDiscordAuthorizationPrompt(event)
        : renderDiscordAuthorizationStatus(event);
    try {
      const posted = await channel.discord.post(message);
      if (posted.id) {
        channel.state.pendingAuthMessageIds = {
          ...channel.state.pendingAuthMessageIds,
          [discordAuthorizationMessageKey(event)]: posted.id,
        };
      }
    } catch (error) {
      log.error("Discord sign-in delivery failed", { error, name: event.name });
    }
  },

  async "authorization.completed"(event, channel, _ctx) {
    if (event.outcome === "authorized") {
      await channel.discord.startTyping();
    }
    const key = discordAuthorizationMessageKey(event);
    const messageId = channel.state.pendingAuthMessageIds?.[key];
    if (messageId === undefined) return;
    const { [key]: _, ...rest } = channel.state.pendingAuthMessageIds ?? {};
    channel.state.pendingAuthMessageIds = rest;
    try {
      await editDiscordMessage(
        channel.discord,
        messageId,
        renderDiscordAuthorizationCompleted(event),
      );
    } catch (error) {
      log.warn("Discord sign-in edit failed", { error, name: event.name });
    }
  },

  async "actions.requested"(_event, channel, _ctx) {
    await channel.discord.startTyping();
  },

  async "input.requested"(event, channel, _ctx) {
    for (const request of event.requests) {
      const content = splitDiscordMessageContent(request.prompt)[0] ?? request.prompt;
      const components = renderInputRequestComponents(request);
      const posted = await channel.discord.post({ components, content });
      if (components.length === 0 || !posted.id) continue;
      channel.state.hitlPrompts = {
        ...channel.state.hitlPrompts,
        [request.requestId]: {
          content,
          messageId: posted.id,
          options: (request.options ?? []).map(({ id, label }) => ({ id, label })),
        },
      };
    }
  },

  // Covers every way a prompt ends: a press, a modal answer, or a withdrawal.
  // The bot token outlives the interaction token the prompt may have been posted with.
  async "input.resolved"(event, channel, _ctx) {
    for (const resolution of event.resolutions) {
      const prompt = channel.state.hitlPrompts?.[resolution.requestId];
      if (prompt === undefined) continue;
      const { [resolution.requestId]: _, ...rest } = channel.state.hitlPrompts ?? {};
      channel.state.hitlPrompts = rest;
      const label = resolvedPromptLabel(resolution, prompt.options);
      try {
        await editDiscordResolvedPrompt(channel.discord, prompt, label);
      } catch (error) {
        log.warn("Discord answered prompt edit failed", { error, requestId: resolution.requestId });
      }
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
        "Send a new message or command to continue.",
        ...(errorId ? ["", `Error id: ${errorId}`] : []),
      ].join("\n"),
    );
  },

  async "turn.failed"(event, channel, _ctx) {
    if (event.terminal) return;
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
