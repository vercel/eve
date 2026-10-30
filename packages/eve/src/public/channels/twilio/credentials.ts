import type { TwilioAccountSid } from "#public/channels/twilio/api.js";
import type { TwilioAuthToken, TwilioWebhookVerifier } from "#public/channels/twilio/verify.js";

/** Credentials for the Twilio channel and its API. */
export interface TwilioChannelCredentials {
  readonly accountSid?: TwilioAccountSid;
  readonly authToken?: TwilioAuthToken;
  /** Verify forwarded webhooks instead of the native Twilio signature. */
  readonly webhookVerifier?: TwilioWebhookVerifier;
}
