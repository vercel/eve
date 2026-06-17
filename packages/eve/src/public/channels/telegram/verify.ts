/**
 * Telegram inbound-webhook verification.
 *
 * When you configure a webhook with `secret_token`, Telegram includes
 * that exact value in `X-Telegram-Bot-Api-Secret-Token` on every
 * webhook request. The native channel verifies the header directly or
 * delegates to a caller-supplied verifier for forwarded webhooks.
 */

import { timingSafeEqual } from "node:crypto";

import { createLogger } from "#internal/logging.js";

const log = createLogger("telegram.verify");

/** Secret token you set on Telegram's `setWebhook` call. */
export type TelegramWebhookSecretToken = string | (() => string | Promise<string>);

/**
 * Caller-supplied inbound webhook verifier. Use it instead of
 * Telegram's secret-token header when an integration authenticates
 * forwarded webhooks before they reach eve.
 *
 * The return value selects how the channel handles the request: return a
 * falsy value to reject the request, a string to accept it and use that
 * string as the verified body, or any other truthy value to accept it and
 * keep the original body.
 */
export type TelegramWebhookVerifier = (
  request: Request,
  body: string,
) => unknown | Promise<unknown>;

/** Options for {@link verifyTelegramRequest}. */
export interface TelegramVerifyOptions {
  readonly secretToken: TelegramWebhookSecretToken | undefined;
  readonly webhookVerifier?: TelegramWebhookVerifier;
}

/** Resolves a Telegram webhook secret, falling back to `TELEGRAM_WEBHOOK_SECRET_TOKEN`. */
export async function resolveTelegramWebhookSecretToken(
  secretToken?: TelegramWebhookSecretToken,
): Promise<string> {
  const source = secretToken ?? process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN;
  if (!source) throw new Error("TELEGRAM_WEBHOOK_SECRET_TOKEN is required.");
  return typeof source === "function" ? await source() : source;
}

/**
 * Verifies an inbound Telegram webhook and returns its raw body.
 *
 * Throws when no secret/verifier is configured, the secret header is
 * missing, or the supplied verifier/header rejects.
 */
export async function verifyTelegramRequest(
  request: Request,
  options: TelegramVerifyOptions,
): Promise<string> {
  const body = await request.text();

  if (options.webhookVerifier !== undefined) {
    const result = await options.webhookVerifier(request, body);
    if (!result) {
      throw new Error("telegramChannel: inbound webhook verifier rejected the request.");
    }
    return typeof result === "string" ? result : body;
  }

  const secretToken = await resolveTelegramWebhookSecretToken(options.secretToken);
  const header = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!header) {
    throw new Error("telegramChannel: inbound request missing Telegram secret-token header.");
  }
  if (!constantTimeCompare(secretToken, header)) {
    throw new Error("telegramChannel: inbound request secret-token mismatch.");
  }
  return body;
}

function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch (error) {
    log.debug("timingSafeEqual threw", { error });
    return false;
  }
}
