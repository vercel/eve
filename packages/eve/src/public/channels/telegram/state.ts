import { telegramContinuationToken } from "#public/channels/telegram/api.js";
import type {
  TelegramCallbackQuery,
  TelegramMessage,
  TelegramUser,
} from "#public/channels/telegram/inbound.js";
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
    conversationId: privateChat ? null : conversationIdForMessage(message),
    messageThreadId: message.messageThreadId ?? null,
    replyToBotMessageId:
      message.replyToMessage?.from?.isBot === true ? message.replyToMessage.messageId : null,
    triggeringUserId: message.from?.id ?? null,
    triggeringUserName:
      message.from === undefined ? null : (telegramUserName(message.from) ?? null),
  };
}

/** How a Telegram user is named on a message everyone in the chat reads. */
export function telegramUserName(user: TelegramUser): string | undefined {
  const name = [user.firstName, user.lastName].filter((part) => part !== undefined && part !== "");
  if (name.length > 0) return name.join(" ");
  return user.username === undefined ? undefined : `@${user.username}`;
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
    conversationId: null,
    hitlCallbacks: {},
    messageThreadId: null,
    nextHitlCallbackId: 0,
    pendingAuthMessageIds: {},
    pendingFreeformReplies: {},
    triggeringUserId: null,
  };
}

function conversationIdForMessage(message: TelegramMessage): string {
  return message.replyToMessage?.from?.isBot === true
    ? message.replyToMessage.messageId
    : message.messageId;
}
