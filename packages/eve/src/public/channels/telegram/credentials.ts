import type { TelegramBotToken } from "#public/channels/telegram/api.js";
import type { TelegramWebhookSecretToken } from "#public/channels/telegram/verify.js";
import type { TelegramWebhookVerifier } from "#public/channels/telegram/verify.js";

/** Credentials for the Telegram channel and its API. */
export interface TelegramChannelCredentials {
  readonly botToken?: TelegramBotToken;
  readonly webhookSecretToken?: TelegramWebhookSecretToken;
  readonly webhookVerifier?: TelegramWebhookVerifier;
}
