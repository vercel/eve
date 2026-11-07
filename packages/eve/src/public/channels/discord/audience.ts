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
 */
export function discordConversationSpace(
  state: DiscordChannelState,
): ConversationSpace | undefined {
  if (!state.channelId) return undefined;
  const type = state.channelType === 1 ? "direct" : state.channelType === 3 ? "group" : "channel";
  return state.guildId
    ? {
        id: `discord:${state.guildId}:${state.channelId}`,
        type,
        workspaceId: `discord:${state.guildId}`,
      }
    : { id: `discord:${state.channelId}`, type: state.channelType === 3 ? "group" : "direct" };
}
