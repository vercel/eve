import {
  callTwilioApi as callPrimitive,
  encodeTwilioForm,
  resolveTwilioCredential,
  TwilioApiError,
  type TwilioApiResponse,
  type TwilioCredential,
  type TwilioFetch,
} from "#compiled/@chat-adapter/twilio/api.js";

import { resolveTwilioAuthToken, type TwilioAuthToken } from "#public/channels/twilio/verify.js";

/**
 * Builds the Twilio channel-local continuation token (`<from>:<to>`).
 * Eve namespaces this with the channel name before handing it to the runtime.
 */
export function twilioContinuationToken(from: string, to: string | undefined): string {
  return `${from}:${to ?? ""}`;
}

/** Twilio Account SID, materialized directly or from an async secret provider. */
export type TwilioAccountSid = TwilioCredential;

export type { TwilioApiResponse, TwilioFetch };

/** Credentials used for Twilio REST API calls and webhook verification. */
export interface TwilioCredentials {
  readonly accountSid?: TwilioAccountSid;
  readonly authToken?: TwilioAuthToken;
}

/** Shared Twilio REST API options. */
export interface TwilioApiOptions {
  readonly credentials?: TwilioCredentials;
  readonly apiBaseUrl?: string;
  readonly fetch?: TwilioFetch;
}

/** Parameters for creating an outbound Twilio message. */
export interface TwilioSendMessageInput extends TwilioApiOptions {
  readonly to: string;
  readonly body: string;
  readonly from?: string;
  readonly messagingServiceSid?: string;
  readonly statusCallbackUrl?: string;
}

/** Parameters for updating a live Twilio call with new TwiML. */
export interface TwilioUpdateCallInput extends TwilioApiOptions {
  readonly callSid: string;
  readonly twiml: string;
}

/** Resolves a Twilio Account SID, falling back to `TWILIO_ACCOUNT_SID`. */
export async function resolveTwilioAccountSid(accountSid?: TwilioAccountSid): Promise<string> {
  try {
    return await resolveTwilioCredential(accountSid, "TWILIO_ACCOUNT_SID");
  } catch (error) {
    if (error instanceof TwilioApiError && error.status === 0) {
      throw new Error("TWILIO_ACCOUNT_SID is required.");
    }
    throw error;
  }
}

/**
 * Calls Twilio's REST API with Basic auth and form-encoded body fields.
 *
 * The return shape intentionally preserves Eve's previous non-throwing HTTP
 * behavior: non-2xx Twilio responses become `{ ok: false, status, body }`.
 */
export async function callTwilioApi(input: {
  readonly credentials?: TwilioCredentials;
  readonly apiBaseUrl?: string;
  readonly fetch?: TwilioFetch;
  readonly path: string;
  readonly body: Readonly<Record<string, string | number | boolean | undefined | null>>;
}): Promise<TwilioApiResponse> {
  const credentials = await resolveCredentials(input.credentials);
  return preserveTwilioApiResponse(
    callPrimitive({
      apiBaseUrl: input.apiBaseUrl,
      body: encodeTwilioForm(input.body),
      credentials,
      fetch: input.fetch,
      path: input.path,
    }),
  );
}

/** Sends an outbound SMS/MMS-style message via Twilio's Messages resource. */
export async function sendTwilioMessage(input: TwilioSendMessageInput): Promise<TwilioApiResponse> {
  if (!input.from && !input.messagingServiceSid) {
    throw new Error("twilioChannel: sending a message requires from or messagingServiceSid.");
  }
  const accountSid = await resolveTwilioAccountSid(input.credentials?.accountSid);
  const credentials = await resolveCredentials(input.credentials);
  return preserveTwilioApiResponse(
    callPrimitive({
      apiBaseUrl: input.apiBaseUrl,
      body: encodeTwilioForm({
        Body: input.body,
        From: input.from,
        MessagingServiceSid: input.messagingServiceSid,
        StatusCallback: input.statusCallbackUrl,
        To: input.to,
      }),
      credentials,
      fetch: input.fetch,
      path: `/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
    }),
  );
}

/** Updates a live Twilio call by posting replacement TwiML to the Calls resource. */
export async function updateTwilioCall(input: TwilioUpdateCallInput): Promise<TwilioApiResponse> {
  const accountSid = await resolveTwilioAccountSid(input.credentials?.accountSid);
  const credentials = await resolveCredentials(input.credentials);
  return preserveTwilioApiResponse(
    callPrimitive({
      apiBaseUrl: input.apiBaseUrl,
      body: encodeTwilioForm({ Twiml: input.twiml }),
      credentials,
      fetch: input.fetch,
      path: `/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls/${encodeURIComponent(
        input.callSid,
      )}.json`,
    }),
  );
}

async function resolveCredentials(
  credentials: TwilioCredentials | undefined,
): Promise<{ accountSid: string; authToken: string }> {
  return {
    accountSid: await resolveTwilioAccountSid(credentials?.accountSid),
    authToken: await resolveTwilioAuthToken(credentials?.authToken),
  };
}

async function preserveTwilioApiResponse(
  response: Promise<TwilioApiResponse>,
): Promise<TwilioApiResponse> {
  try {
    return await response;
  } catch (error) {
    if (error instanceof TwilioApiError && error.status !== 0) {
      return {
        body: error.body,
        ok: false,
        status: error.status,
      };
    }
    throw error;
  }
}
