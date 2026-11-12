import type { ChannelAudience } from "#shared/channel-audience.js";
import type { TelegramInstrumentationMetadata } from "#public/channels/telegram/index.js";
import type { TelegramChannelState } from "#public/channels/telegram/telegramChannel.js";
import type {
  AudienceContext,
  ConversationSpace,
  ConversationSpaceContext,
} from "#shared/conversation-context.js";

function telegramInstrumentationMetadata(
  state: TelegramChannelState,
): TelegramInstrumentationMetadata {
  return {
    chatId: state.chatId,
    chatType: state.chatType,
    triggeringUserId: state.triggeringUserId ?? null,
  };
}

function telegramAudience(state: TelegramChannelState): ChannelAudience {
  return telegramAudienceForChatType(state.chatType);
}

/** The Telegram chat a session is in. Chat IDs are global, so they need no workspace. */
function telegramSpace(state: TelegramChannelState): ConversationSpace | undefined {
  if (!state.chatId) return undefined;
  switch (state.chatType) {
    case "private":
      return { id: `telegram:${state.chatId}`, type: "direct", visibility: "private" };
    case "group":
      // A basic group has no public link; a supergroup or channel may.
      return { id: `telegram:${state.chatId}`, type: "shared", visibility: "private" };
    case "supergroup":
    case "channel":
      return { id: `telegram:${state.chatId}`, type: "shared" };
    default:
      return undefined;
  }
}

export const telegramInstrumentation = {
  audience: (input: AudienceContext<TelegramChannelState>) => telegramAudience(input.state),
  space: (input: ConversationSpaceContext<TelegramChannelState>) => telegramSpace(input.state),
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
