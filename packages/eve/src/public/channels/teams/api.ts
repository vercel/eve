/**
 * Minimal Microsoft Teams Bot Framework Connector REST wrapper.
 *
 * The native Teams channel talks directly to the Bot Framework Activity
 * protocol instead of exposing BotBuilder or Teams SDK objects through
 * eve public APIs.
 */

import { parseJsonObject, type JsonObject } from "#shared/json.js";
import { isObject } from "#shared/guards.js";

/** Microsoft application id, materialized directly or from an async secret provider. */
export type TeamsAppId = string | (() => string | Promise<string>);

/** Microsoft application password, materialized directly or from an async secret provider. */
export type TeamsAppPassword = string | (() => string | Promise<string>);

/** Microsoft tenant id, materialized directly or from an async secret provider. */
export type TeamsTenantId = string | (() => string | Promise<string>);

/** Fetch implementation override used by tests or non-standard runtimes. */
export type TeamsFetch = typeof fetch;

/** Result shape accepted from a caller-owned Bot Connector token provider. */
export type TeamsAccessTokenResult =
  | string
  | {
      readonly accessToken: string;
      readonly expiresAt?: Date | number;
    };

/** Caller-owned Bot Connector token provider. */
export type TeamsTokenProvider = () => TeamsAccessTokenResult | Promise<TeamsAccessTokenResult>;

/** Credentials used by the native Teams channel. */
export interface TeamsCredentials {
  readonly appId?: TeamsAppId;
  readonly appPassword?: TeamsAppPassword;
  readonly tenantId?: TeamsTenantId;
  readonly tokenProvider?: TeamsTokenProvider;
}

/** Shared Teams API options. */
export interface TeamsApiOptions {
  readonly credentials?: TeamsCredentials;
  /** Fetch override for tests or non-standard runtimes. */
  readonly fetch?: TeamsFetch;
  /**
   * Microsoft OAuth host for the client-credentials token flow. Defaults to
   * `https://login.microsoftonline.com`. eve ignores it when
   * `credentials.tokenProvider` is set.
   */
  readonly loginBaseUrl?: string;
}

/** Raw Teams Connector API response body. */
export interface TeamsApiResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly body: unknown;
}

/** Minimal ResourceResponse object returned by Teams write operations. */
export interface TeamsPostedActivity {
  /** Teams/Bot Framework activity id, when one was returned. */
  readonly id: string;
  /** Connector's raw JSON response. */
  readonly raw: unknown;
}

/** Bot Framework channel account shape surfaced by the native Teams channel. */
export interface TeamsChannelAccount {
  readonly aadObjectId?: string;
  readonly id: string;
  readonly name?: string;
  readonly role?: string;
}

/** Bot Framework mention entity shape used by Teams messages. */
export interface TeamsMention {
  readonly mentioned: TeamsChannelAccount;
  readonly text: string;
  readonly type: "mention";
}

/** Bot Framework/Teams attachment shape supported by eve-owned APIs. */
export interface TeamsAttachment {
  readonly content?: JsonObject;
  readonly contentType: string;
  readonly contentUrl?: string;
  readonly name?: string;
}

/** JSON body supported by Teams message endpoints used by eve. */
export interface TeamsMessageBody {
  readonly attachments?: readonly TeamsAttachment[];
  readonly channelData?: JsonObject;
  readonly entities?: readonly TeamsMention[];
  readonly inputHint?: string;
  readonly speak?: string;
  readonly suggestedActions?: JsonObject;
  readonly text?: string;
  readonly textFormat?: "markdown" | "plain" | "xml";
}

/**
 * Outbound Bot Framework activity body sent through the Connector API.
 * `type: "message"` carries the message fields; `type: "typing"` is a
 * content-free typing indicator sent as-is, without normalization or
 * channelData merging.
 */
export interface TeamsOutboundActivity extends TeamsMessageBody {
  readonly conversation?: JsonObject;
  readonly from?: TeamsChannelAccount;
  readonly recipient?: TeamsChannelAccount;
  readonly replyToId?: string;
  readonly type: "message" | "typing";
}

/** Maximum character length for a single outbound Teams activity before `splitTeamsMessageText` chunks it (80 KiB). */
export const TEAMS_MESSAGE_TEXT_MAX_LENGTH = 80 * 1024;

const DEFAULT_LOGIN_BASE_URL = "https://login.microsoftonline.com";
const BOT_FRAMEWORK_TENANT = "botframework.com";
const BOT_FRAMEWORK_SCOPE = "https://api.botframework.com/.default";

const accessTokenCache = new Map<
  string,
  { readonly accessToken: string; readonly expiresAt: number }
>();

/** Builds the channel-local continuation token for one Teams conversation/thread. */
export function teamsContinuationToken(input: {
  readonly conversationId: string;
  readonly replyToActivityId?: string | null;
  readonly tenantId?: string | null;
}): string {
  return [input.tenantId ?? "_", input.conversationId, input.replyToActivityId ?? ""]
    .map((component) => encodeURIComponent(component))
    .join(":");
}

/** Resolves a Teams app id, falling back to `MICROSOFT_APP_ID` then `TEAMS_APP_ID`. */
export async function resolveTeamsAppId(appId?: TeamsAppId): Promise<string> {
  const source = appId ?? process.env.MICROSOFT_APP_ID ?? process.env.TEAMS_APP_ID;
  if (!source) throw new Error("MICROSOFT_APP_ID or TEAMS_APP_ID is required.");
  return typeof source === "function" ? await source() : source;
}

/** Resolves a Teams app password, falling back to `MICROSOFT_APP_PASSWORD` then `TEAMS_APP_PASSWORD`. */
export async function resolveTeamsAppPassword(appPassword?: TeamsAppPassword): Promise<string> {
  const source =
    appPassword ?? process.env.MICROSOFT_APP_PASSWORD ?? process.env.TEAMS_APP_PASSWORD;
  if (!source) throw new Error("MICROSOFT_APP_PASSWORD or TEAMS_APP_PASSWORD is required.");
  return typeof source === "function" ? await source() : source;
}

/** Resolves a Teams tenant id, falling back to `MICROSOFT_TENANT_ID` then `TEAMS_TENANT_ID`. */
export async function resolveTeamsTenantId(tenantId?: TeamsTenantId): Promise<string | undefined> {
  const source = tenantId ?? process.env.MICROSOFT_TENANT_ID ?? process.env.TEAMS_TENANT_ID;
  if (!source) return undefined;
  return typeof source === "function" ? await source() : source;
}

/** Resolves a Bot Connector access token, using a custom provider or client credentials. */
export async function resolveTeamsAccessToken(options: TeamsApiOptions = {}): Promise<string> {
  const credentials = options.credentials;
  if (credentials?.tokenProvider !== undefined) {
    return normalizeAccessTokenResult(await credentials.tokenProvider()).accessToken;
  }

  const appId = await resolveTeamsAppId(credentials?.appId);
  const appPassword = await resolveTeamsAppPassword(credentials?.appPassword);
  const tenantId = await resolveTeamsTenantId(credentials?.tenantId);
  const loginBaseUrl = trimTrailingSlash(options.loginBaseUrl ?? DEFAULT_LOGIN_BASE_URL);
  const cacheKey = `${loginBaseUrl}:${tenantId ?? BOT_FRAMEWORK_TENANT}:${appId}`;
  const cached = accessTokenCache.get(cacheKey);
  const now = Date.now();
  if (cached !== undefined && cached.expiresAt - 60_000 > now) {
    return cached.accessToken;
  }

  const tokenUrl = `${loginBaseUrl}/${encodeURIComponent(
    tenantId ?? BOT_FRAMEWORK_TENANT,
  )}/oauth2/v2.0/token`;
  const form = new URLSearchParams({
    client_id: appId,
    client_secret: appPassword,
    grant_type: "client_credentials",
    scope: BOT_FRAMEWORK_SCOPE,
  });
  const apiFetch = options.fetch ?? fetch;
  const response = await apiFetch(tokenUrl, {
    body: form,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const body = await parseResponseBody(response);
  if (!response.ok) {
    throw new Error(`Teams access-token request failed with HTTP ${response.status}.`);
  }
  const raw = isObject(body) ? body : {};
  const accessToken = typeof raw.access_token === "string" ? raw.access_token : "";
  if (!accessToken) {
    throw new Error("Teams access-token response did not include access_token.");
  }
  const expiresInSeconds = typeof raw.expires_in === "number" ? raw.expires_in : 3600;
  accessTokenCache.set(cacheKey, {
    accessToken,
    expiresAt: now + expiresInSeconds * 1000,
  });
  return accessToken;
}

/** Low-level Bot Framework Connector API call. */
export async function callTeamsConnectorApi(
  input: TeamsApiOptions & {
    readonly body?: TeamsOutboundActivity | JsonObject;
    readonly method?: "DELETE" | "GET" | "POST" | "PUT";
    readonly path: string;
    readonly serviceUrl: string;
  },
): Promise<TeamsApiResponse> {
  const apiFetch = input.fetch ?? fetch;
  const headers = new Headers();
  headers.set("authorization", `Bearer ${await resolveTeamsAccessToken(input)}`);
  headers.set("content-type", "application/json; charset=utf-8");

  const init: RequestInit = {
    headers,
    method: input.method ?? "POST",
  };
  if (input.body !== undefined) {
    init.body = JSON.stringify(parseJsonObject(input.body));
  }

  const response = await apiFetch(`${trimTrailingSlash(input.serviceUrl)}${input.path}`, init);
  return {
    body: await parseResponseBody(response),
    ok: response.ok,
    status: response.status,
  };
}

/** Sends a non-reply activity to one Teams conversation. */
export async function sendTeamsActivity(
  input: TeamsApiOptions & {
    readonly body: TeamsOutboundActivity;
    readonly conversationId: string;
    readonly serviceUrl: string;
  },
): Promise<TeamsPostedActivity> {
  const response = await callTeamsConnectorApi({
    ...input,
    body: input.body,
    path: `/v3/conversations/${encodeURIComponent(input.conversationId)}/activities`,
  });
  if (!response.ok) {
    throw new Error(`Teams send activity failed with HTTP ${response.status}.`);
  }
  return toPostedActivity(response.body);
}

/** Sends a reply activity to one Teams conversation activity. */
export async function replyToTeamsActivity(
  input: TeamsApiOptions & {
    readonly activityId: string;
    readonly body: TeamsOutboundActivity;
    readonly conversationId: string;
    readonly serviceUrl: string;
  },
): Promise<TeamsPostedActivity> {
  const response = await callTeamsConnectorApi({
    ...input,
    body: input.body,
    path: `/v3/conversations/${encodeURIComponent(input.conversationId)}/activities/${encodeURIComponent(
      input.activityId,
    )}`,
  });
  if (!response.ok) {
    throw new Error(`Teams reply activity failed with HTTP ${response.status}.`);
  }
  return toPostedActivity(response.body);
}

/** Updates an existing Teams bot activity. */
export async function updateTeamsActivity(
  input: TeamsApiOptions & {
    readonly activityId: string;
    readonly body: TeamsOutboundActivity;
    readonly conversationId: string;
    readonly serviceUrl: string;
  },
): Promise<TeamsPostedActivity> {
  const response = await callTeamsConnectorApi({
    ...input,
    body: input.body,
    method: "PUT",
    path: `/v3/conversations/${encodeURIComponent(input.conversationId)}/activities/${encodeURIComponent(
      input.activityId,
    )}`,
  });
  if (!response.ok) {
    throw new Error(`Teams update activity failed with HTTP ${response.status}.`);
  }
  return toPostedActivity(response.body);
}

/** Triggers Teams' typing indicator for one conversation. */
export async function triggerTeamsTypingIndicator(
  input: TeamsApiOptions & {
    readonly conversationId: string;
    readonly serviceUrl: string;
  },
): Promise<void> {
  const response = await callTeamsConnectorApi({
    ...input,
    body: { type: "typing" },
    path: `/v3/conversations/${encodeURIComponent(input.conversationId)}/activities`,
  });
  if (!response.ok) {
    throw new Error(`Teams typing indicator failed with HTTP ${response.status}.`);
  }
}

/**
 * Splits `content` into chunks no longer than `TEAMS_MESSAGE_TEXT_MAX_LENGTH`,
 * breaking on paragraph, then line, then word boundaries before a hard cut.
 * Returns a single-element array when `content` already fits.
 */
export function splitTeamsMessageText(content: string): readonly string[] {
  if (content.length <= TEAMS_MESSAGE_TEXT_MAX_LENGTH) return [content];

  const chunks: string[] = [];
  let rest = content;
  while (rest.length > TEAMS_MESSAGE_TEXT_MAX_LENGTH) {
    let cut = rest.lastIndexOf("\n\n", TEAMS_MESSAGE_TEXT_MAX_LENGTH);
    if (cut <= 0) cut = rest.lastIndexOf("\n", TEAMS_MESSAGE_TEXT_MAX_LENGTH);
    if (cut <= 0) cut = rest.lastIndexOf(" ", TEAMS_MESSAGE_TEXT_MAX_LENGTH);
    if (cut <= 0) cut = TEAMS_MESSAGE_TEXT_MAX_LENGTH;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  chunks.push(rest);
  return chunks;
}

/** Normalizes a string or message body into a Teams message activity body. */
export function normalizeTeamsPostInput(message: string | TeamsMessageBody): TeamsMessageBody {
  if (typeof message === "string") {
    return { text: message, textFormat: "markdown" };
  }
  return message;
}

function normalizeAccessTokenResult(result: TeamsAccessTokenResult): {
  readonly accessToken: string;
  readonly expiresAt?: number;
} {
  if (typeof result === "string") return { accessToken: result };
  const expiresAt =
    result.expiresAt instanceof Date ? result.expiresAt.getTime() : result.expiresAt;
  return {
    accessToken: result.accessToken,
    expiresAt,
  };
}

function toPostedActivity(body: unknown): TeamsPostedActivity {
  const raw = isObject(body) ? body : {};
  return {
    id: typeof raw.id === "string" ? raw.id : "",
    raw: body,
  };
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
