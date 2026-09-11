import { normalizeChannelAudience, type ChannelAudience } from "#shared/channel-audience.js";
import type {
  DiscordChannelState,
  DiscordCommandResult,
} from "#public/channels/discord/discordChannel.js";
import type { DiscordInstrumentationMetadata } from "#public/channels/discord/index.js";
import type { DiscordInteraction } from "#public/channels/discord/inbound.js";

export function discordAudience(
  channelType: number | undefined,
  guildId: string | undefined,
): ChannelAudience {
  if (guildId === undefined) return "private";
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

export function discordStateFromInteraction(
  interaction: DiscordInteraction,
  options: {
    readonly conversationId: string;
    readonly hasMessageAnchor: boolean;
    readonly initialResponseSent: boolean;
  },
): DiscordChannelState {
  return {
    audience: discordAudience(interaction.channelType, interaction.guildId),
    applicationId: interaction.applicationId,
    channelId: interaction.channelId,
    conversationId: options.conversationId,
    guildId: interaction.guildId ?? null,
    hasMessageAnchor: options.hasMessageAnchor,
    initialResponseSent: options.initialResponseSent,
    interactionToken: interaction.token,
  };
}

export function discordCommandAudience(
  platformAudience: ChannelAudience | undefined,
  result: Exclude<DiscordCommandResult, null>,
): ChannelAudience {
  if (platformAudience === "private" || result.ephemeral === true) return "private";
  const explicitAudience = normalizeChannelAudience(result.audience);
  return explicitAudience === "unknown" ? (platformAudience ?? "unknown") : explicitAudience;
}

export function initialDiscordState(): DiscordChannelState {
  return {
    audience: "unknown",
    applicationId: null,
    channelId: null,
    conversationId: null,
    guildId: null,
    hasMessageAnchor: false,
    initialResponseSent: false,
    interactionToken: null,
  };
}
