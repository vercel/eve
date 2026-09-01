import type { ChannelAudience } from "#shared/channel-audience.js";
import type { TelegramInstrumentationMetadata } from "#public/channels/telegram/index.js";
import type { TelegramChannelState } from "#public/channels/telegram/telegramChannel.js";

export function telegramInstrumentationMetadata(
  state: TelegramChannelState,
): TelegramInstrumentationMetadata {
  return {
    audience: telegramAudience(state.chatType),
    chatId: state.chatId,
    chatType: state.chatType,
    triggeringUserId: state.triggeringUserId ?? null,
  };
}

function telegramAudience(chatType: TelegramChannelState["chatType"]): ChannelAudience {
  if (
    chatType === "private" ||
    chatType === "group" ||
    chatType === "supergroup" ||
    chatType === "channel"
  ) {
    return "private";
  }
  return "unknown";
}
