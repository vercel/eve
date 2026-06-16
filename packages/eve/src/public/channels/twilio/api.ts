/**
 * Minimal Twilio REST API wrapper used by the Twilio channel.
 *
 * Requests use Twilio's normal `application/x-www-form-urlencoded`
 * body encoding and HTTP Basic auth. No Twilio SDK dependency is
 * required or exposed through eve public APIs.
 */

import { resolveTwilioAuthToken, type TwilioAuthToken } from "#public/channels/twilio/verify.js";

/**
 * Builds the Twilio channel-local continuation token
 * (`<from>:<to>`). Route `send()` namespaces this with the channel
 * name before passing it to the runtime (`twilio:<from>:<to>`), so
 * Twilio routes should pass the raw channel-local form returned
 * here. `to` may be empty for proactive sessions that don't yet know
 * the Twilio sender number.
 */
export function twilioContinuationToken(from: string, to: string | undefined): string {
  return `${from}:${to ?? ""}`;
}

/** Twilio Account SID, materialized directly or from an async secret provider. */
export type TwilioAccountSid = string | (() => string | Promise<string>);

/** Fetch implementation override matching the global `fetch` signature. Defaults to the runtime global; supply a custom one for tests or non-standard runtimes. */
export type TwilioFetch = typeof fetch;

/** Credentials required for Twilio REST API calls and webhook verification. */
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

/**
 * Result of a Twilio REST call: HTTP `status`, an `ok` flag, and `body`.
 * `body` holds parsed JSON for a JSON response, the raw text string
 * otherwise, or `null` when empty.
 */
export interface TwilioApiResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly body: unknown;
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
  const source = accountSid ?? process.env.TWILIO_ACCOUNT_SID;
  if (!source) throw new Error("TWILIO_ACCOUNT_SID is required.");
  return typeof source === "function" ? await source() : source;
}

/**
 * Calls Twilio's REST API with Basic auth and form-encoded body fields.
 *
 * `path` is relative to `https://api.twilio.com` by default and may be
 * pointed elsewhere through `apiBaseUrl` for tests or proxies.
 */
export async function callTwilioApi(input: {
  readonly credentials?: TwilioCredentials;
  readonly apiBaseUrl?: string;
  readonly fetch?: TwilioFetch;
  readonly path: string;
  readonly body: Readonly<Record<string, string | number | boolean | undefined | null>>;
}): Promise<TwilioApiResponse> {
  const accountSid = await resolveTwilioAccountSid(input.credentials?.accountSid);
  const authToken = await resolveTwilioAuthToken(input.credentials?.authToken);
  const apiFetch = input.fetch ?? fetch;
  const url = `${input.apiBaseUrl ?? "https://api.twilio.com"}${input.path}`;
  const body = encodeForm(input.body);
  const response = await apiFetch(url, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
    body,
  });
  return {
    status: response.status,
    ok: response.ok,
    body: await parseResponseBody(response),
  };
}

/** Sends an outbound SMS/MMS-style message via Twilio's Messages resource. */
export async function sendTwilioMessage(input: TwilioSendMessageInput): Promise<TwilioApiResponse> {
  if (!input.from && !input.messagingServiceSid) {
    throw new Error("twilioChannel: sending a message requires from or messagingServiceSid.");
  }
  const accountSid = await resolveTwilioAccountSid(input.credentials?.accountSid);
  return callTwilioApi({
    apiBaseUrl: input.apiBaseUrl,
    credentials: input.credentials,
    fetch: input.fetch,
    path: `/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
    body: {
      Body: input.body,
      From: input.from,
      MessagingServiceSid: input.messagingServiceSid,
      StatusCallback: input.statusCallbackUrl,
      To: input.to,
    },
  });
}

/** Updates a live Twilio call by posting replacement TwiML to the Calls resource. */
export async function updateTwilioCall(input: TwilioUpdateCallInput): Promise<TwilioApiResponse> {
  const accountSid = await resolveTwilioAccountSid(input.credentials?.accountSid);
  return callTwilioApi({
    apiBaseUrl: input.apiBaseUrl,
    credentials: input.credentials,
    fetch: input.fetch,
    path: `/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls/${encodeURIComponent(
      input.callSid,
    )}.json`,
    body: { Twiml: input.twiml },
  });
}

function encodeForm(
  body: Readonly<Record<string, string | number | boolean | undefined | null>>,
): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }
  return params;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
