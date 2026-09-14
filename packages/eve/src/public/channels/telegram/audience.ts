import type { ChannelAudience } from "#shared/channel-audience.js";
import type { TelegramInstrumentationMetadata } from "#public/channels/telegram/index.js";
import type { TelegramChannelState } from "#public/channels/telegram/telegramChannel.js";
import type { AudienceInput } from "#shared/conversation-context.js";

export function telegramInstrumentationMetadata(
  state: TelegramChannelState,
): TelegramInstrumentationMetadata {
  return {
    chatId: state.chatId,
    chatType: state.chatType,
    triggeringUserId: state.triggeringUserId ?? null,
  };
}

export function telegramAudience(state: TelegramChannelState): ChannelAudience {
  return telegramAudienceForChatType(state.chatType);
}

export const telegramInstrumentation = {
  audience: (input: AudienceInput<TelegramChannelState>) => telegramAudience(input.state),
  metadata: telegramInstrumentationMetadata,
} as const;

function telegramAudienceForChatType(chatType: TelegramChannelState["chatType"]): ChannelAudience {
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
