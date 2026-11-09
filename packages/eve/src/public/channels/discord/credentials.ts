import type { DiscordApplicationId } from "#public/channels/discord/api.js";
import type { DiscordBotToken } from "#public/channels/discord/api.js";
import type { DiscordPublicKey } from "#public/channels/discord/verify.js";
import type { DiscordWebhookVerifier } from "#public/channels/discord/verify.js";

/** Credentials for the Discord channel and its API. */
export interface DiscordChannelCredentials {
  readonly applicationId?: DiscordApplicationId;
  readonly botToken?: DiscordBotToken;
  readonly publicKey?: DiscordPublicKey;
  readonly webhookVerifier?: DiscordWebhookVerifier;
}
