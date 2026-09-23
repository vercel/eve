/**
 * The seam between eve and the vendored Slack transport: the host and fetch
 * every outbound call travels on, and the record of whether a thrown error
 * means Slack answered.
 */

import {
  callSlackApi as callSlackApiPrimitive,
  type SlackApiOptions,
  type SlackApiResponse,
} from "#compiled/@chat-adapter/slack/api.js";

/** Fetch implementation used for Slack traffic. */
export type SlackFetch = typeof globalThis.fetch;

/**
 * Slack API transport overrides. The base URLs say where a call may go:
 * `apiBaseUrl` defaults to `https://slack.com/api/`, and `fileBaseUrl` falls back to
 * `apiBaseUrl` for attachment downloads. Both are absolute http or https URLs
 * carrying no query string or fragment. `fetch` says how all Slack traffic travels,
 * downloads from Slack's own file hosts included: it replaces the global fetch, which
 * attaches the per-call header a host behind an authenticating proxy requires, and
 * observes or stubs the traffic.
 */
export interface SlackTransportOptions {
  readonly apiBaseUrl?: string;
  readonly fetch?: SlackFetch;
  readonly fileBaseUrl?: string;
}

/**
 * Checks the configured bases and resolves each to the directory href that method
 * names and file paths resolve against, throwing on one eve cannot reach. Call it
 * where the channel is constructed: `fileBaseUrl` absorbs its fallback here, and
 * every outbound call then reads a resolved string.
 */
export function resolveSlackTransportOptions(
  api: SlackTransportOptions | undefined,
): SlackTransportOptions | undefined {
  if (api === undefined) return undefined;
  const apiBaseUrl = slackBaseHref(api.apiBaseUrl, "api.apiBaseUrl");
  const fileBaseUrl =
    api.fileBaseUrl === undefined ? apiBaseUrl : slackBaseHref(api.fileBaseUrl, "api.fileBaseUrl");
  return { apiBaseUrl, fetch: api.fetch, fileBaseUrl };
}

/** The options an outbound Slack Web API call is made with. */
export function slackApiOptions(
  api: SlackTransportOptions | undefined,
  token: SlackApiOptions["token"],
): SlackApiOptions {
  return { apiUrl: api?.apiBaseUrl, fetch: api?.fetch, token };
}

/**
 * True when a configured file base serves `url`, which makes it downloadable with
 * the bot token. The match is a path prefix, so an `apiBaseUrl` of
 * `https://slack.com/api/` authorizes downloads under that path alone.
 */
export function isConfiguredSlackFileUrl(
  api: SlackTransportOptions | undefined,
  url: string,
): boolean {
  const base = api?.fileBaseUrl;
  if (base === undefined) return false;
  return URL.parse(url)?.href.startsWith(base) === true;
}

/** Method names and file paths resolve relative to the base, so it names a directory. */
function slackBaseHref(base: string | undefined, option: string): string | undefined {
  if (base === undefined) return undefined;
  const parsed = URL.parse(base);
  if (parsed === null || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    throw new TypeError(`${option} must be an absolute http or https URL. Received: ${base}`);
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new TypeError(`${option} must carry no query string or fragment. Received: ${base}`);
  }
  return parsed.href.endsWith("/") ? parsed.href : `${parsed.href}/`;
}

/** Errors raised after Slack's response arrived. */
const slackResponseErrors = new WeakSet<object>();

/**
 * POSTs to a Slack Web API method and records the response arriving.
 *
 * Slack retries an interaction whose acknowledgement is not a 2xx, so a
 * handler answering a click has to swallow a call Slack answered badly
 * and rethrow a call that never arrived. Those two are indistinguishable
 * once thrown: the transport consumes the response body before it reads
 * the status, so a body cut off partway raises the same `TypeError` as a
 * connection that was never made. Nothing on the error says which it
 * was, so the answer is recorded here while the call runs. `callSlackApi`
 * posts through here, which covers `ctx.slack.request` and the
 * `views.open` that opens the freeform modal; the message, upload and
 * thread-fetch helpers in `api.ts` post through the vendored transport.
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
