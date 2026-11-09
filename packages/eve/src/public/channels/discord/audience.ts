import type { ChannelAudience } from "#shared/channel-audience.js";
import type { ConversationSpace } from "#shared/conversation-context.js";
import type { DiscordChannelState } from "#public/channels/discord/discordChannel.js";
import type { DiscordInstrumentationMetadata } from "#public/channels/discord/index.js";

export function discordAudience(channelType: number | undefined): ChannelAudience {
  if (channelType === 1 || channelType === 3 || channelType === 12) return "private";
  return "unknown";
}

export function discordInstrumentationMetadata(
  state: DiscordChannelState,
): DiscordInstrumentationMetadata {
  return {
    channelId: state.channelId,
    guildId: state.guildId,
  };
}

/**
 * The Discord channel a session is in. DMs (type 1) are direct and group DMs
 * (type 3) are groups; a thread reports itself, since its parent isn't known.
 * A proactive session knows neither its guild nor its channel type, so it
 * reports no space rather than one that differs from its channel's.
 */
export function discordConversationSpace(
  state: DiscordChannelState,
): ConversationSpace | undefined {
  if (!state.channelId) return undefined;
  if (state.guildId) {
    return {
      id: `discord:${state.guildId}:${state.channelId}`,
      type: "channel",
      workspaceId: `discord:${state.guildId}`,
    };
  }
  if (state.channelType === 1) return { id: `discord:${state.channelId}`, type: "direct" };
  if (state.channelType === 3) return { id: `discord:${state.channelId}`, type: "group" };
  return undefined;
}
