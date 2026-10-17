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
  type TelegramChannelContext,
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
  telegramContinuationToken,
  type TelegramApiOptions,
  type TelegramApiResponse,
  type TelegramBotToken,
  type TelegramCredentials,
  type TelegramEphemeralMessageParameters,
  type TelegramFetch,
  type TelegramMessageBody,
  type TelegramMessageResult,
} from "#public/channels/telegram/api.js";

export {
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
  type TelegramHitlState,
  type TelegramInteractionMessage,
} from "#public/channels/telegram/hitl.js";

export { defaultTelegramAuth } from "#public/channels/telegram/defaults.js";

export {
  type TelegramWebhookSecretToken,
  type TelegramWebhookVerifier,
} from "#public/channels/telegram/verify.js";
