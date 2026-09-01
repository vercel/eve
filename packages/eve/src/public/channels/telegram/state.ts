import {
  telegramContinuationToken,
  type TelegramMessageResult,
} from "#public/channels/telegram/api.js";
import type { TelegramCallbackQuery, TelegramMessage } from "#public/channels/telegram/inbound.js";
import type { TelegramChannelState } from "#public/channels/telegram/telegramChannel.js";

export function stateFromTelegramMessage(
  message: TelegramMessage,
  botUsername: string | undefined,
): TelegramChannelState {
  const privateChat = message.chat.type === "private";
  return {
    ...initialTelegramState(botUsername),
    chatId: message.chat.id,
    chatType: message.chat.type,
    chatUsername: message.chat.username ?? null,
    conversationId: privateChat ? null : conversationIdForMessage(message),
    messageThreadId: message.messageThreadId ?? null,
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
  const privateChat = message.chat.type === "private";
  return {
    ...initialTelegramState(botUsername),
    chatId: message.chat.id,
    chatType: message.chat.type,
    chatUsername: message.chat.username ?? null,
    conversationId: privateChat ? null : message.messageId,
    messageThreadId: message.messageThreadId ?? null,
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
    chatUsername: null,
    conversationId: null,
    hitlCallbacks: {},
    messageThreadId: null,
    nextHitlCallbackId: 0,
    pendingAuthMessageIds: {},
    pendingFreeformReplies: {},
    triggeringUserId: null,
  };
}

export function updateTelegramChatMetadata(
  state: TelegramChannelState,
  posted: TelegramMessageResult,
): void {
  if (state.chatType === null && posted.chatType !== undefined) state.chatType = posted.chatType;
  if (posted.chatUsername !== undefined) {
    state.chatUsername = posted.chatUsername;
  } else if (posted.chatType === "supergroup" || posted.chatType === "channel") {
    state.chatUsername = null;
  }
}

function conversationIdForMessage(message: TelegramMessage): string {
  return message.replyToMessage?.from?.isBot === true
    ? message.replyToMessage.messageId
    : message.messageId;
}
