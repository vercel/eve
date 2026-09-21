/**
 * Slack Web API transport seam: bot-token resolution, the configurable
 * base URL and fetch implementation, and the low-level call primitive
 * every outbound Slack call in the channel funnels through.
 *
 * Kept separate from `api.ts` so the thread/workspace handles can depend
 * on the transport without the transport depending on them.
 */

import {
  callSlackApi as callSlackApiPrimitive,
  resolveSlackBotToken as resolveSlackBotTokenPrimitive,
  SlackApiError,
  type SlackApiOptions,
  type SlackApiResponse as SlackPrimitiveApiResponse,
} from "#compiled/@chat-adapter/slack/api.js";

import { withSlackRateLimitRetry } from "#public/channels/slack/rate-limit.js";

export { SlackApiError };

/** Slack app installation workspace available when eve resolves a bot token. */
export interface SlackBotTokenContext {
  readonly teamId?: string;
}

/**
 * Slack bot token, materialized either as a literal `xoxb-...` string or
 * as a (possibly async) function that receives the app installation workspace.
 */
export type SlackBotToken = string | ((context: SlackBotTokenContext) => string | Promise<string>);

/** Slack's own Web API base. Used when nothing overrides it. */
const DEFAULT_SLACK_API_URL = "https://slack.com/api/";

/**
 * Points the channel's Slack Web API traffic somewhere other than
 * Slack — a local simulator, a proxy, or a recorded fixture server.
 * Every outbound Slack call the channel makes honors it.
 */
export interface SlackApiConfig {
  /**
   * Slack Web API base URL. Falls back to `process.env.SLACK_API_URL`,
   * then to `https://slack.com/api/`. Must be absolute and carry no query
   * string or fragment; its path is normalized to a trailing slash so
   * method names resolve as an extra path segment instead of replacing
   * the last one.
   */
  readonly url?: string;
  /**
   * Fetch implementation used for Slack Web API calls and authenticated
   * `url_private` file downloads. Defaults to the global `fetch`. eve
   * wraps whichever is used so a Slack 429 is retried after the delay
   * `Retry-After` asks for; a call that is rate limited is therefore
   * seen more than once here.
   */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Resolves the Slack Web API base URL from explicit config, then
 * `SLACK_API_URL`, then Slack's own host. Read at call time so a process
 * that sets the env var after import still picks it up.
 *
 * Method names are appended by relative URL resolution, which keeps only
 * the origin and the directory part of the base. Normalizing the parsed
 * pathname — rather than the raw string — is what makes `…/api` behave as
 * `…/api/`, and a query or fragment is rejected because resolution would
 * silently drop it along with the path it trails.
 */
export function resolveSlackApiUrl(api?: SlackApiConfig): string {
  const configured = api?.url ?? process.env.SLACK_API_URL;
  const base =
    configured !== undefined && configured.length > 0 ? configured : DEFAULT_SLACK_API_URL;

  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new Error(
      `Slack API base URL must be absolute, received ${JSON.stringify(base)}. ` +
        `Set a full URL such as "http://localhost:3000/api/slack".`,
    );
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new Error(
      `Slack API base URL must not carry a query string or fragment, received ${JSON.stringify(base)}. ` +
        `Slack method names are appended as a path segment, so anything after the path would be dropped.`,
    );
  }
  if (!parsed.pathname.endsWith("/")) parsed.pathname = `${parsed.pathname}/`;
  return parsed.toString();
}

/**
 * Materializes a {@link SlackBotToken} to a string, falling back to
 * `process.env.SLACK_BOT_TOKEN`. Throws when neither is set.
 */
export async function resolveSlackBotToken(
  token?: SlackBotToken,
  context: SlackBotTokenContext = {},
): Promise<string> {
  const source = token ?? process.env.SLACK_BOT_TOKEN;
  if (!source) throw new Error("SLACK_BOT_TOKEN is required.");
  if (typeof source === "function") return source(context);
  return resolveSlackBotTokenPrimitive(source);
}

/**
 * Slack Web API JSON response envelope. `ok` signals success, `error`
 * carries Slack's error code on failure, and method-specific fields pass
 * through verbatim. Callers inspect `ok` themselves.
 */
export type SlackApiResponse = SlackPrimitiveApiResponse;

/**
 * Low-level POST to a Slack Web API method, signed with the bot token
 * and form-encoded. Form is the only safe default: Slack's JSON support
 * is partial (e.g. `conversations.replies` rejects JSON). Returns the
 * raw JSON response; callers inspect `response.ok` themselves.
 */
export async function callSlackApi(input: {
  readonly botToken: SlackBotToken | undefined;
  readonly context?: SlackBotTokenContext;
  readonly operation: string;
  readonly body: unknown;
  /**
   * Slack Web API base URL. Falls back to `process.env.SLACK_API_URL`,
   * then to Slack's own host. Same constraints as {@link SlackApiConfig.url}.
   */
  readonly apiUrl?: string;
  /** Fetch implementation for this call. Defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
}): Promise<SlackApiResponse> {
  return callSlackApiPrimitive(
    input.operation,
    normalizeSlackApiBody(input.body),
    createSlackApiOptions(input.botToken, input.context, {
      url: input.apiUrl,
      fetch: input.fetch,
    }),
  );
}

/**
 * Builds the `request(op, body)` Slack API caller installed on every
 * Slack handle. Resolves the bot token at call time so rotated
 * credentials are picked up without rebuilding the binding.
 */
export function createSlackRequester(
  botToken: SlackBotToken | undefined,
  context: SlackBotTokenContext,
  api: SlackApiConfig | undefined,
): (operation: string, body: unknown) => Promise<SlackApiResponse> {
  return (operation, body) =>
    callSlackApi({ botToken, context, operation, body, apiUrl: api?.url, fetch: api?.fetch });
}

/**
 * Transport options for the vendored Slack helpers, carrying the lazily
 * resolved bot token plus the configured base URL and fetch.
 */
export function createSlackApiOptions(
  botToken: SlackBotToken | undefined,
  context: SlackBotTokenContext = {},
  api?: SlackApiConfig,
): SlackApiOptions {
  return {
    apiUrl: resolveSlackApiUrl(api),
    fetch: resolveSlackFetch(api),
    token: () => resolveSlackBotToken(botToken, context),
  };
}

/**
 * The fetch every outbound Slack call goes through: the configured one,
 * or the global, wrapped so a 429 is retried after the delay Slack asks
 * for instead of aborting the turn. Also used for the file downloads that
 * bypass the Web API primitive.
 */
export function resolveSlackFetch(api?: SlackApiConfig): typeof globalThis.fetch {
  return withSlackRateLimitRetry(api?.fetch);
}

/**
 * JSON-encoded POST to a Slack Web API method, for the two surfaces
 * (`views.open`, the answered-card `chat.update`) whose payloads Slack
 * only accepts as JSON. Throws {@link SlackApiError} on a non-2xx
 * response; an `{ ok: false }` body comes back for the caller to inspect.
 */
export async function callSlackApiJson(input: {
  readonly api: SlackApiConfig | undefined;
  readonly body: Record<string, unknown>;
  readonly method: string;
  readonly token: string;
}): Promise<SlackApiResponse> {
  return callSlackApiPrimitive(input.method, input.body, {
    ...createSlackApiOptions(input.token, {}, input.api),
    contentType: "json",
  });
}

function normalizeSlackApiBody(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return {};
}
