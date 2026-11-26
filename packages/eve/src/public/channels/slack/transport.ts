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
 * carrying no query string or fragment.
 *
 * `fetch` says how the traffic travels: it replaces the global fetch, which attaches
 * the per-call header a host behind an authenticating proxy requires, and observes or
 * stubs the calls. It is confined to the configured bases' origins, so a wrapper may
 * attach a credential without checking each destination itself. With no base
 * configured every call goes to Slack's own hosts and it sees all of them.
 */
export interface SlackTransportOptions {
  readonly apiBaseUrl?: string;
  readonly fetch?: SlackFetch;
  readonly fileBaseUrl?: string;
}

const resolvedTransports = new WeakSet<object>();

export function resolveSlackTransportOptions(
  api: SlackTransportOptions | undefined,
): SlackTransportOptions | undefined {
  if (api === undefined) return undefined;
  if (resolvedTransports.has(api)) return api;
  const apiBaseUrl = slackBaseHref(api.apiBaseUrl, "api.apiBaseUrl");
  const fileBaseUrl =
    api.fileBaseUrl === undefined ? apiBaseUrl : slackBaseHref(api.fileBaseUrl, "api.fileBaseUrl");
  const resolved = {
    apiBaseUrl,
    fetch: confineFetch(api.fetch, apiBaseUrl, fileBaseUrl),
    fileBaseUrl,
  };
  resolvedTransports.add(resolved);
  return resolved;
}

function confineFetch(
  custom: SlackFetch | undefined,
  apiBaseUrl: string | undefined,
  fileBaseUrl: string | undefined,
): SlackFetch | undefined {
  if (custom === undefined) return undefined;
  const bases = [apiBaseUrl, fileBaseUrl].filter((base) => base !== undefined);
  if (bases.length === 0) return custom;
  const origins = new Set(bases.map((base) => new URL(base).origin));
  return (target, init) => {
    const origin = URL.parse(target instanceof Request ? target.url : String(target))?.origin;
    return origin !== undefined && origins.has(origin)
      ? custom(target, init)
      : globalThis.fetch(target, init);
  };
}

export function slackApiOptions(
  api: SlackTransportOptions | undefined,
  token: SlackApiOptions["token"],
): SlackApiOptions {
  const resolved = resolveSlackTransportOptions(api);
  return { apiUrl: resolved?.apiBaseUrl, fetch: resolved?.fetch, token };
}

export function isConfiguredSlackFileUrl(
  api: SlackTransportOptions | undefined,
  url: string,
): boolean {
  const base = api?.fileBaseUrl;
  if (base === undefined) return false;
  return URL.parse(url)?.href.startsWith(base) === true;
}

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

const slackResponseErrors = new WeakSet<object>();

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

export interface SlackApiResult {
  readonly body: SlackApiResponse;
  readonly headers: Headers;
}

export async function callSlackApiWithHeaders(
  operation: string,
  body: Record<string, unknown>,
  options: SlackApiOptions,
  timeoutMs: number,
): Promise<SlackApiResult> {
  let headers = new Headers();
  const observe: typeof globalThis.fetch = async (input, init) => {
    const response = await (options.fetch ?? globalThis.fetch)(input, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
    headers = response.headers;
    return response;
  };
  const response = await callSlackApiPrimitive(operation, body, { ...options, fetch: observe });
  return { body: response, headers };
}

export function isSlackResponseError(error: unknown): boolean {
  return typeof error === "object" && error !== null && slackResponseErrors.has(error);
}
