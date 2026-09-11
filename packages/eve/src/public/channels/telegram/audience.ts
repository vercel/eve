import type { ChannelAudience } from "#shared/channel-audience.js";
import type { TelegramInstrumentationMetadata } from "#public/channels/telegram/index.js";
import type { TelegramChannelState } from "#public/channels/telegram/telegramChannel.js";

export function telegramInstrumentationMetadata(
  state: TelegramChannelState,
): TelegramInstrumentationMetadata {
  return {
    audience: telegramAudience(state.chatType, state.chatUsername),
    chatId: state.chatId,
    chatType: state.chatType,
    triggeringUserId: state.triggeringUserId ?? null,
  };
}

function telegramAudience(
  chatType: TelegramChannelState["chatType"],
  chatUsername: TelegramChannelState["chatUsername"],
): ChannelAudience {
  if (chatType === null) return "unknown";
  if (
    (chatType === "supergroup" || chatType === "channel") &&
    typeof chatUsername === "string" &&
    chatUsername.length > 0
  ) {
    return "public";
  }
  return "private";
}
