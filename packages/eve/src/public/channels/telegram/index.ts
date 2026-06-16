export type { ModelMessage } from "ai";

/**
 * Per-session instrumentation metadata for the Telegram channel, exposed to
 * observability tooling. The channel derives `chatId`, `chatType`, and
 * `triggeringUserId` from the current channel state; each stays `null` until an
 * inbound update populates it.
 */
export interface TelegramInstrumentationMetadata extends Record<string, unknown> {
  readonly chatId: string | null;
  readonly chatType: import("#public/channels/telegram/inbound.js").TelegramChatType | null;
  readonly triggeringUserId: string | null;
}

export {
  telegramChannel,
  type TelegramChannel,
  type TelegramChannelConfig,
  type TelegramChannelCredentials,
  type TelegramChannelEvents,
  type TelegramChannelState,
  type TelegramContext,
  type TelegramEventContext,
  type TelegramHandle,
  type TelegramInboundResult,
  type TelegramInboundResultOrPromise,
  type TelegramReceiveTarget,
} from "#public/channels/telegram/telegramChannel.js";

export {
  callTelegramApi,
  answerTelegramCallbackQuery,
  downloadTelegramFile,
  editTelegramMessageReplyMarkup,
  getTelegramFile,
  resolveTelegramBotToken,
  sendTelegramChatAction,
  sendTelegramMessage,
  splitTelegramMessageText,
  telegramContinuationToken,
  TELEGRAM_MESSAGE_TEXT_MAX_LENGTH,
  type TelegramApiOptions,
  type TelegramApiResponse,
  type TelegramBotToken,
  type TelegramCredentials,
  type TelegramFetch,
  type TelegramMessageBody,
  type TelegramMessageResult,
} from "#public/channels/telegram/api.js";

export {
  formatTelegramContextBlock,
  parseTelegramUpdate,
  type TelegramAttachment,
  type TelegramCallbackQuery,
  type TelegramChat,
  type TelegramChatType,
  type TelegramInboundContext,
  type TelegramMessage,
  type TelegramMessageReference,
  type TelegramUpdate,
  type TelegramUser,
} from "#public/channels/telegram/inbound.js";

export {
  TELEGRAM_CALLBACK_RESPONSE_PREFIX,
  TELEGRAM_HITL_CALLBACK_PREFIX,
  TELEGRAM_REPLY_RESPONSE_PREFIX,
  isTelegramSyntheticResponse,
  registerTelegramFreeformPrompt,
  renderTelegramInputRequest,
  resolveTelegramInputResponses,
  telegramCallbackInputResponse,
  telegramReplyInputResponse,
  type TelegramHitlState,
  type TelegramInputRequestMessage,
} from "#public/channels/telegram/hitl.js";

export {
  TELEGRAM_FILE_URL_PROTOCOL,
  buildTelegramTurnMessage,
  collectTelegramFileParts,
  createTelegramFetchFile,
  createTelegramFileUrl,
} from "#public/channels/telegram/attachments.js";

export { defaultTelegramAuth } from "#public/channels/telegram/defaults.js";

export {
  resolveTelegramWebhookSecretToken,
  verifyTelegramRequest,
  type TelegramVerifyOptions,
  type TelegramWebhookSecretToken,
  type TelegramWebhookVerifier,
} from "#public/channels/telegram/verify.js";
