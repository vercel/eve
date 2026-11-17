import { createHmac } from "node:crypto";

import { resolveTwilioCredential, TwilioApiError } from "#compiled/@chat-adapter/twilio/api.js";
import {
  twilioSignatureBase,
  verifyTwilioRequest as verifyPrimitive,
  TwilioWebhookVerificationError,
} from "#compiled/@chat-adapter/twilio/webhook.js";

/** Twilio auth token, materialized directly or from an async secret provider. */
export type TwilioAuthToken = string | (() => string | Promise<string>);

export type TwilioWebhookUrl = string | ((request: Request) => string | Promise<string>);

export interface TwilioVerifiedRequest {
  readonly body: string;
  readonly params: URLSearchParams;
}

export interface TwilioVerifyOptions {
  readonly authToken: TwilioAuthToken | undefined;
  readonly webhookUrl?: TwilioWebhookUrl;
}

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

export function signTwilioRequest(input: {
  readonly authToken: string;
  readonly url: string;
  readonly params: URLSearchParams;
}): string {
  const base = buildTwilioSignatureBase(input.url, input.params);
  return createHmac("sha1", input.authToken).update(base).digest("base64");
}

export function buildTwilioSignatureBase(url: string, params: URLSearchParams): string {
  return twilioSignatureBase(url, params);
}
