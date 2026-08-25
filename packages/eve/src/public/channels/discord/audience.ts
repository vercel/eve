import type { ChannelAudience } from "#shared/channel-audience.js";
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
    audience: state.audience ?? "unknown",
    channelId: state.channelId,
    guildId: state.guildId,
  };
}
