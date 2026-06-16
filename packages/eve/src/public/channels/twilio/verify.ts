/**
 * Twilio inbound-webhook verification.
 *
 * Twilio signs webhook requests with `X-Twilio-Signature`. For form
 * posts, the signed payload is the exact public URL Twilio called plus
 * every POST parameter sorted by name and appended as `name + value`.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { createLogger } from "#internal/logging.js";

const log = createLogger("twilio.verify");

/** Auth token, materialized either directly or from an async secret provider. */
export type TwilioAuthToken = string | (() => string | Promise<string>);

/** Public URL resolver used when the runtime request URL differs from Twilio's configured URL. */
export type TwilioWebhookUrl = string | ((request: Request) => string | Promise<string>);

/**
 * Parsed and verified Twilio webhook body.
 *
 * `params` contains every form parameter Twilio sent. Signature
 * validation happens before the channel reads any business fields.
 */
export interface TwilioVerifiedRequest {
  readonly body: string;
  readonly params: URLSearchParams;
}

/** Options for {@link verifyTwilioRequest}. */
export interface TwilioVerifyOptions {
  /** Auth token used to verify the signature. When undefined, falls back to `TWILIO_AUTH_TOKEN`. */
  readonly authToken: TwilioAuthToken | undefined;
  /** Public URL Twilio signed. Defaults to `request.url`; set this when a proxy or tunnel rewrites the URL. */
  readonly webhookUrl?: TwilioWebhookUrl;
}

/** Resolves a Twilio auth token, falling back to `TWILIO_AUTH_TOKEN`. */
export async function resolveTwilioAuthToken(authToken?: TwilioAuthToken): Promise<string> {
  const source = authToken ?? process.env.TWILIO_AUTH_TOKEN;
  if (!source) throw new Error("TWILIO_AUTH_TOKEN is required.");
  return typeof source === "function" ? await source() : source;
}

/**
 * Verifies an inbound Twilio webhook and returns the raw body plus parsed form params.
 *
 * Consumes the request body, so the passed `Request` cannot be re-read afterward.
 * The signed URL comes from `options.webhookUrl` (falling back to `request.url`).
 * Set `webhookUrl` when a proxy or tunnel rewrites the URL. A rewritten URL causes
 * the signed payload to differ, so the signature check fails.
 *
 * Throws when the auth token is missing, the `X-Twilio-Signature` header is absent,
 * or the computed signature does not match.
 */
export async function verifyTwilioRequest(
  request: Request,
  options: TwilioVerifyOptions,
): Promise<TwilioVerifiedRequest> {
  const body = await request.text();
  const params = new URLSearchParams(body);
  const authToken = await resolveTwilioAuthToken(options.authToken);
  const signature = request.headers.get("x-twilio-signature") ?? "";
  if (!signature) {
    throw new Error("twilioChannel: inbound request missing X-Twilio-Signature.");
  }

  const url = await resolveWebhookUrl(request, options.webhookUrl);
  const expected = signTwilioRequest({ authToken, params, url });
  if (!constantTimeCompare(expected, signature)) {
    throw new Error("twilioChannel: inbound request signature mismatch.");
  }

  return { body, params };
}

/** Computes Twilio's HMAC-SHA1 request signature. */
export function signTwilioRequest(input: {
  readonly authToken: string;
  readonly url: string;
  readonly params: URLSearchParams;
}): string {
  const base = buildTwilioSignatureBase(input.url, input.params);
  return createHmac("sha1", input.authToken).update(base).digest("base64");
}

/** Builds the string Twilio signs for a form POST webhook. */
export function buildTwilioSignatureBase(url: string, params: URLSearchParams): string {
  const entries = Array.from(params.entries()).sort(([aName, aValue], [bName, bValue]) => {
    const nameOrder = aName < bName ? -1 : aName > bName ? 1 : 0;
    if (nameOrder !== 0) return nameOrder;
    return aValue < bValue ? -1 : aValue > bValue ? 1 : 0;
  });
  let base = url;
  for (const [name, value] of entries) {
    base += `${name}${value}`;
  }
  return base;
}

async function resolveWebhookUrl(
  request: Request,
  webhookUrl: TwilioWebhookUrl | undefined,
): Promise<string> {
  if (typeof webhookUrl === "function") return webhookUrl(request);
  return webhookUrl ?? request.url;
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
