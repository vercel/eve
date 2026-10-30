import type { TwilioAccountSid } from "#public/channels/twilio/api.js";
import type { TwilioAuthToken, TwilioWebhookVerifier } from "#public/channels/twilio/verify.js";

/** Credentials for the Twilio channel and its API. */
export interface TwilioChannelCredentials {
  readonly accountSid?: TwilioAccountSid;
  readonly authToken?: TwilioAuthToken;
  /** Accept verified forwarded webhooks in addition to native Twilio signatures. */
  readonly webhookVerifier?: TwilioWebhookVerifier;
}
