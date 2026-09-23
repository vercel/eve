/**
 * Records whether a Slack Web API call got a response.
 *
 * Slack retries an interaction whose acknowledgement is not a 2xx, so a
 * handler answering a click has to swallow a call Slack answered badly
 * and rethrow a call that never arrived. Those two are indistinguishable
 * once thrown: the transport consumes the response body before it reads
 * the status, so a body cut off partway raises the same `TypeError` as a
 * connection that was never made. Nothing on the error says which it
 * was, so every Slack call eve makes goes out through here and the
 * answer is recorded while the call runs.
 *
 * Separate from `api.ts` because that file sits on the 700-line cap
 * `internal/structural-tests/file-length.test.ts` enforces.
 */

import {
  callSlackApi as callSlackApiPrimitive,
  type SlackApiOptions,
  type SlackApiResponse,
} from "#compiled/@chat-adapter/slack/api.js";

/** Errors raised after Slack's response arrived. */
const slackResponseErrors = new WeakSet<object>();

/**
 * POSTs to a Slack Web API method and records the response arriving.
 *
 * The transport is handed a `fetch` that observes the response, so
 * everything thrown from that moment on — a non-2xx, a body that is not
 * the JSON envelope, a body cut off mid-read — is marked for
 * {@link isSlackResponseError}. A failure before then stays unmarked and
 * reaches the caller, which is what fails the interaction request.
 */
export async function callSlackApiTrackingResponse(
  operation: string,
  body: Record<string, unknown>,
  options: SlackApiOptions,
): Promise<SlackApiResponse> {
  let responded = false;
  const observe: typeof globalThis.fetch = async (input, init) => {
    const response = await (options.fetch ?? globalThis.fetch)(input, init);
    responded = true;
    return response;
  };
  try {
    return await callSlackApiPrimitive(operation, body, { ...options, fetch: observe });
  } catch (error) {
    if (responded && typeof error === "object" && error !== null) {
      slackResponseErrors.add(error);
    }
    throw error;
  }
}

/**
 * True when Slack answered the call, false when the call never got a
 * response. A caller that must acknowledge Slack swallows the first and
 * rethrows the second; see {@link callSlackApiTrackingResponse} for why
 * the error itself cannot be asked.
 */
export function isSlackResponseError(error: unknown): boolean {
  return typeof error === "object" && error !== null && slackResponseErrors.has(error);
}
