import { telegramContinuationToken } from "#public/channels/telegram/api.js";
import type {
  TelegramCallbackQuery,
  TelegramMessage,
  TelegramMessageReference,
} from "#public/channels/telegram/inbound.js";
import type { TelegramChannelState } from "#public/channels/telegram/telegramChannel.js";

export function stateFromTelegramMessage(
  message: TelegramMessage,
  botUsername: string | undefined,
): TelegramChannelState {
  return {
    ...initialTelegramState(botUsername),
    chatId: message.chat.id,
    chatType: message.chat.type,
    conversationId: null,
    messageThreadId: sessionThreadId(message),
    triggeringUserId: message.from?.id ?? null,
  };
}

export function stateFromTelegramCallbackQuery(
  query: TelegramCallbackQuery,
  botUsername: string | undefined,
): TelegramChannelState {
  const message = query.message;
  if (!message) {
    return { ...initialTelegramState(botUsername), triggeringUserId: query.from.id };
  }
  return {
    ...initialTelegramState(botUsername),
    chatId: message.chat.id,
    chatType: message.chat.type,
    conversationId: null,
    messageThreadId: sessionThreadId(message),
    triggeringUserId: query.from.id,
  };
}

export function telegramContinuationTokenFromState(state: TelegramChannelState): string {
  return telegramContinuationToken({
    chatId: state.chatId ?? "",
    conversationId: state.chatType === "private" ? undefined : (state.conversationId ?? undefined),
    messageThreadId: state.messageThreadId ?? undefined,
  });
}

export function initialTelegramState(botUsername: string | undefined): TelegramChannelState {
  return {
    botUsername: botUsername ?? null,
    chatId: null,
    chatType: null,
    conversationId: null,
    hitlCallbacks: {},
    messageThreadId: null,
    nextHitlCallbackId: 0,
    pendingAuthMessageIds: {},
    pendingFreeformReplies: {},
    triggeringUserId: null,
  };
}

function sessionThreadId(message: TelegramMessageReference): number | null {
  const threadId = message.messageThreadId ?? null;
  if (message.chat.type === "private") return threadId;
  return message.isTopicMessage === true ? threadId : null;
}
