/**
 * Minimal Discord REST API wrapper. The channel talks directly to Discord's
 * JSON HTTP API rather than exposing a third-party SDK through eve.
 */

import { parseJsonObject, type JsonObject } from "#shared/json.js";
import { isObject } from "#shared/guards.js";

import { resolveDiscordPublicKey, type DiscordPublicKey } from "#public/channels/discord/verify.js";

/** Discord application id, materialized directly or from an async secret provider. */
export type DiscordApplicationId = string | (() => string | Promise<string>);

/** Discord bot token, materialized directly or from an async secret provider. */
export type DiscordBotToken = string | (() => string | Promise<string>);

/** Fetch implementation override used by tests or non-standard runtimes. */
export type DiscordFetch = typeof fetch;

/**
 * Credentials used by the native Discord channel. Each field falls back to the
 * matching `DISCORD_*` env var when omitted.
 */
export interface DiscordCredentials {
  /** Required to edit or follow up on interaction responses. Falls back to `DISCORD_APPLICATION_ID`. */
  readonly applicationId?: DiscordApplicationId;
  /** Required for channel messages and typing indicators. Falls back to `DISCORD_BOT_TOKEN`. */
  readonly botToken?: DiscordBotToken;
  /** Required for inbound Ed25519 interaction verification. Falls back to `DISCORD_PUBLIC_KEY`. */
  readonly publicKey?: DiscordPublicKey;
}

/** Shared Discord API options. */
export interface DiscordApiOptions {
  readonly apiBaseUrl?: string;
  readonly credentials?: DiscordCredentials;
  readonly fetch?: DiscordFetch;
}

/** Raw Discord API call result. `body` is parsed JSON, or text/null when not JSON. */
export interface DiscordApiResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly body: unknown;
}

/** Minimal Discord message object returned by channel write operations. */
export interface DiscordPostedMessage {
  /** Discord message id, when Discord returned one. */
  readonly id: string;
  /** Channel id associated with the message, when Discord returned one. */
  readonly channelId?: string;
  /** Discord's raw JSON response. */
  readonly raw: unknown;
}

/** Allowed mentions payload that suppresses all generated pings. */
export const DISCORD_NO_MENTIONS: JsonObject = { parse: [] };

/** Discord's documented message-content cap. */
export const DISCORD_MESSAGE_CONTENT_MAX_LENGTH = 2000;

/** Builds the channel-local continuation token (`<channelId>:<conversationId>`). */
export function discordContinuationToken(
  channelId: string,
  conversationId: string | undefined,
): string {
  return `${channelId}:${conversationId ?? ""}`;
}

/** Resolves a Discord application id, falling back to `DISCORD_APPLICATION_ID`. */
export async function resolveDiscordApplicationId(
  applicationId?: DiscordApplicationId,
): Promise<string> {
  const source = applicationId ?? process.env.DISCORD_APPLICATION_ID;
  if (!source) throw new Error("DISCORD_APPLICATION_ID is required.");
  return typeof source === "function" ? await source() : source;
}

/** Resolves a Discord bot token, falling back to `DISCORD_BOT_TOKEN`. */
export async function resolveDiscordBotToken(botToken?: DiscordBotToken): Promise<string> {
  const source = botToken ?? process.env.DISCORD_BOT_TOKEN;
  if (!source) throw new Error("DISCORD_BOT_TOKEN is required.");
  return typeof source === "function" ? await source() : source;
}

export { resolveDiscordPublicKey };

/**
 * Low-level Discord JSON API call. Defaults to POST against
 * `https://discord.com/api/v10`. Bot-token auth is added only when a token is
 * supplied (interaction webhook endpoints run unauthenticated). Does not throw
 * on non-2xx, so callers must inspect `ok`/`status`.
 */
export async function callDiscordApi(input: {
  readonly apiBaseUrl?: string;
  readonly body?: JsonObject;
  readonly botToken?: DiscordBotToken;
  readonly fetch?: DiscordFetch;
  readonly method?: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
  readonly path: string;
}): Promise<DiscordApiResponse> {
  const apiFetch = input.fetch ?? fetch;
  const headers = new Headers();
  headers.set("content-type", "application/json; charset=utf-8");
  if (input.botToken !== undefined) {
    const token = await resolveDiscordBotToken(input.botToken);
    headers.set("authorization", `Bot ${token}`);
  }

  const init: RequestInit = {
    headers,
    method: input.method ?? "POST",
  };
  if (input.body !== undefined) {
    init.body = JSON.stringify(parseJsonObject(input.body));
  }

  const response = await apiFetch(
    `${input.apiBaseUrl ?? "https://discord.com/api/v10"}${input.path}`,
    init,
  );
  return {
    body: await parseResponseBody(response),
    ok: response.ok,
    status: response.status,
  };
}

/** Sends a bot-authenticated message to one Discord channel. */
export async function sendDiscordChannelMessage(
  input: DiscordApiOptions & {
    readonly body: DiscordMessageBody;
    readonly channelId: string;
  },
): Promise<DiscordPostedMessage> {
  const response = await callDiscordApi({
    apiBaseUrl: input.apiBaseUrl,
    body: normalizeMessageBody(input.body),
    botToken: input.credentials?.botToken,
    fetch: input.fetch,
    path: `/channels/${encodeURIComponent(input.channelId)}/messages`,
  });
  if (!response.ok) {
    throw new Error(`Discord create message failed with HTTP ${response.status}.`);
  }
  return toPostedMessage(response.body);
}

/** Triggers Discord's short-lived channel typing indicator with bot auth. */
export async function triggerDiscordTypingIndicator(
  input: DiscordApiOptions & {
    readonly channelId: string;
  },
): Promise<void> {
  const response = await callDiscordApi({
    apiBaseUrl: input.apiBaseUrl,
    botToken: input.credentials?.botToken,
    fetch: input.fetch,
    path: `/channels/${encodeURIComponent(input.channelId)}/typing`,
  });
  if (!response.ok) {
    throw new Error(`Discord typing indicator failed with HTTP ${response.status}.`);
  }
}

/** Edits the original response for a deferred Discord interaction. */
export async function editDiscordOriginalResponse(
  input: DiscordApiOptions & {
    readonly body: DiscordMessageBody;
    readonly interactionToken: string;
  },
): Promise<DiscordPostedMessage> {
  const applicationId = await resolveDiscordApplicationId(input.credentials?.applicationId);
  const response = await callDiscordApi({
    apiBaseUrl: input.apiBaseUrl,
    body: normalizeMessageBody(input.body),
    fetch: input.fetch,
    method: "PATCH",
    path: `/webhooks/${encodeURIComponent(applicationId)}/${encodeURIComponent(
      input.interactionToken,
    )}/messages/@original`,
  });
  if (!response.ok) {
    throw new Error(`Discord edit original response failed with HTTP ${response.status}.`);
  }
  return toPostedMessage(response.body);
}

/** Creates a Discord interaction followup message. */
export async function createDiscordFollowupMessage(
  input: DiscordApiOptions & {
    readonly body: DiscordMessageBody;
    readonly interactionToken: string;
  },
): Promise<DiscordPostedMessage> {
  const applicationId = await resolveDiscordApplicationId(input.credentials?.applicationId);
  const response = await callDiscordApi({
    apiBaseUrl: input.apiBaseUrl,
    body: normalizeMessageBody(input.body),
    fetch: input.fetch,
    path: `/webhooks/${encodeURIComponent(applicationId)}/${encodeURIComponent(
      input.interactionToken,
    )}`,
  });
  if (!response.ok) {
    throw new Error(`Discord followup message failed with HTTP ${response.status}.`);
  }
  return toPostedMessage(response.body);
}

/**
 * JSON body for the Discord message endpoints eve calls. When
 * `allowed_mentions` is omitted, channel write helpers default it to
 * {@link DISCORD_NO_MENTIONS} (no pings); set it explicitly to allow mentions.
 */
export interface DiscordMessageBody {
  readonly allowed_mentions?: Readonly<Record<string, unknown>>;
  readonly components?: readonly Readonly<Record<string, unknown>>[];
  readonly content?: string;
  readonly flags?: number;
  readonly tts?: boolean;
}

/**
 * Splits text into chunks Discord accepts as individual message contents. An
 * empty string yields one empty chunk so callers can handle no-content messages.
 */
export function splitDiscordMessageContent(content: string): readonly string[] {
  if (content.length <= DISCORD_MESSAGE_CONTENT_MAX_LENGTH) return [content];

  const chunks: string[] = [];
  let rest = content;
  while (rest.length > DISCORD_MESSAGE_CONTENT_MAX_LENGTH) {
    let cut = rest.lastIndexOf("\n", DISCORD_MESSAGE_CONTENT_MAX_LENGTH);
    if (cut <= 0) {
      cut = rest.lastIndexOf(" ", DISCORD_MESSAGE_CONTENT_MAX_LENGTH);
    }
    if (cut <= 0) cut = DISCORD_MESSAGE_CONTENT_MAX_LENGTH;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  chunks.push(rest);
  return chunks;
}

function normalizeMessageBody(body: DiscordMessageBody): JsonObject {
  const normalized: Record<string, unknown> = { ...body };
  if (normalized.allowed_mentions === undefined) {
    normalized.allowed_mentions = DISCORD_NO_MENTIONS;
  }
  return parseJsonObject(normalized);
}

function toPostedMessage(body: unknown): DiscordPostedMessage {
  const raw = parseMaybeObject(body);
  return {
    channelId: typeof raw.channel_id === "string" ? raw.channel_id : undefined,
    id: typeof raw.id === "string" ? raw.id : "",
    raw: body,
  };
}

function parseMaybeObject(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
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
