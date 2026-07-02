import { createHmac } from "node:crypto";

import {
  resolveTwilioCredential,
  TwilioApiError,
  type TwilioCredential,
} from "#compiled/@chat-adapter/twilio/api.js";
import {
  twilioSignatureBase,
  verifyTwilioRequest as verifyPrimitive,
  TwilioWebhookVerificationError,
  type TwilioVerifiedRequest,
  type TwilioWebhookUrl,
} from "#compiled/@chat-adapter/twilio/webhook.js";

/** Twilio auth token, materialized directly or from an async secret provider. */
export type TwilioAuthToken = TwilioCredential;

export type { TwilioVerifiedRequest, TwilioWebhookUrl };

/** Options for verifying Twilio inbound webhooks. */
export interface TwilioVerifyOptions {
  /** Auth token used to verify the signature. Defaults to `TWILIO_AUTH_TOKEN`. */
  readonly authToken: TwilioAuthToken | undefined;
  /** Public URL Twilio signed. Set this when a proxy or tunnel rewrites `request.url`. */
  readonly webhookUrl?: TwilioWebhookUrl;
}

/** Resolves a Twilio auth token, falling back to `TWILIO_AUTH_TOKEN`. */
export async function resolveTwilioAuthToken(authToken?: TwilioAuthToken): Promise<string> {
  try {
    return await resolveTwilioCredential(authToken, "TWILIO_AUTH_TOKEN");
  } catch (error) {
    if (error instanceof TwilioApiError && error.status === 0) {
      throw new Error("TWILIO_AUTH_TOKEN is required.");
    }
    throw error;
  }
}

/**
 * Verifies an inbound Twilio webhook and returns the raw body plus parsed params.
 *
 * This preserves Eve's existing error messages while delegating signature
 * semantics to the Chat SDK Twilio primitive.
 */
export async function verifyTwilioRequest(
  request: Request,
  options: TwilioVerifyOptions,
): Promise<TwilioVerifiedRequest> {
  const signature = request.headers.get("x-twilio-signature");
  if (!signature) {
    throw new Error("twilioChannel: inbound request missing X-Twilio-Signature.");
  }

  const authToken = await resolveTwilioAuthToken(options.authToken);
  try {
    return await verifyPrimitive(request, {
      authToken,
      webhookUrl: options.webhookUrl,
    });
  } catch (error) {
    if (error instanceof TwilioWebhookVerificationError) {
      throw new Error("twilioChannel: inbound request signature mismatch.");
    }
    throw error;
  }
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

/** Builds the string Twilio signs for a webhook request. */
export function buildTwilioSignatureBase(url: string, params: URLSearchParams): string {
  return twilioSignatureBase(url, params);
}
