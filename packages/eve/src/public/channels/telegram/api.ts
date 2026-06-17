/**
 * Minimal Telegram Bot API wrapper for the Telegram channel.
 *
 * The channel talks directly to Telegram's JSON HTTP API instead of
 * exposing a third-party SDK through eve public surfaces.
 */

import { parseJsonObject, type JsonObject } from "#shared/json.js";
import { isObject } from "#shared/guards.js";

/** Telegram bot token, materialized directly or from an async secret provider. */
export type TelegramBotToken = string | (() => string | Promise<string>);

/** Fetch implementation override for tests or non-standard runtimes. */
export type TelegramFetch = typeof fetch;

/** Credentials for the native Telegram channel. */
export interface TelegramCredentials {
  readonly botToken?: TelegramBotToken;
}

/**
 * Common options for the Telegram API helpers. `apiBaseUrl` defaults to
 * `https://api.telegram.org`; `fileBaseUrl` falls back to `apiBaseUrl` for file
 * downloads. `fetch` overrides the global fetch; `credentials` carries the bot token.
 */
export interface TelegramApiOptions {
  readonly apiBaseUrl?: string;
  readonly credentials?: TelegramCredentials;
  readonly fetch?: TelegramFetch;
  readonly fileBaseUrl?: string;
}

/**
 * Decoded result of a Telegram JSON API call: `body` is the parsed response
 * (JSON object, string, or null); `ok` and `status` mirror the HTTP response.
 */
export interface TelegramApiResponse {
  readonly body: unknown;
  readonly ok: boolean;
  readonly status: number;
}

/** Minimal Telegram message object returned by channel write operations. */
export interface TelegramMessageResult {
  /** Telegram message id, or `""` when Telegram returned no message id. */
  readonly id: string;
  /** Telegram chat id associated with the message, when Telegram returned one. */
  readonly chatId?: string;
  /** Telegram's raw JSON response. */
  readonly raw: unknown;
}

/**
 * Body for Telegram's `sendMessage`. Only `text` is required; the remaining
 * snake_case fields are forwarded to Telegram unchanged.
 */
export interface TelegramMessageBody {
  readonly disable_notification?: boolean;
  readonly link_preview_options?: Readonly<Record<string, unknown>>;
  readonly message_thread_id?: number;
  readonly protect_content?: boolean;
  readonly reply_markup?: Readonly<Record<string, unknown>>;
  readonly reply_parameters?: Readonly<Record<string, unknown>>;
  readonly text: string;
}

/** Telegram's documented text-message cap. */
export const TELEGRAM_MESSAGE_TEXT_MAX_LENGTH = 4096;

/**
 * Builds the channel-local continuation token.
 *
 * Private chats use only `chatId`; group and forum-topic sessions add
 * `messageThreadId` and `conversationId` so multiple bot conversations in the
 * same chat do not collapse into one session.
 */
export function telegramContinuationToken(input: {
  readonly chatId: number | string;
  readonly conversationId?: number | string;
  readonly messageThreadId?: number;
}): string {
  const thread = input.messageThreadId === undefined ? "" : String(input.messageThreadId);
  const conversation = input.conversationId === undefined ? "" : String(input.conversationId);
  return `${String(input.chatId)}:${thread}:${conversation}`;
}

/** Resolves a Telegram bot token, falling back to `TELEGRAM_BOT_TOKEN`. */
export async function resolveTelegramBotToken(token?: TelegramBotToken): Promise<string> {
  const source = token ?? process.env.TELEGRAM_BOT_TOKEN;
  if (!source) throw new Error("TELEGRAM_BOT_TOKEN is required.");
  return typeof source === "function" ? await source() : source;
}

/** Low-level Telegram JSON API call. */
export async function callTelegramApi(input: {
  readonly apiBaseUrl?: string;
  readonly body?: JsonObject;
  readonly botToken?: TelegramBotToken;
  readonly fetch?: TelegramFetch;
  readonly method: string;
}): Promise<TelegramApiResponse> {
  const apiFetch = input.fetch ?? fetch;
  const token = await resolveTelegramBotToken(input.botToken);
  const init: RequestInit = {
    headers: { "content-type": "application/json; charset=utf-8" },
    method: "POST",
  };
  if (input.body !== undefined) {
    init.body = JSON.stringify(parseJsonObject(input.body));
  }

  const response = await apiFetch(
    `${input.apiBaseUrl ?? "https://api.telegram.org"}/bot${token}/${encodeURIComponent(
      input.method,
    )}`,
    init,
  );
  return {
    body: await parseResponseBody(response),
    ok: response.ok,
    status: response.status,
  };
}

/** Sends a text message through Telegram's `sendMessage` method. */
export async function sendTelegramMessage(
  input: TelegramApiOptions & {
    readonly body: TelegramMessageBody;
    readonly chatId: number | string;
  },
): Promise<TelegramMessageResult> {
  const response = await callTelegramApi({
    apiBaseUrl: input.apiBaseUrl,
    body: normalizeTelegramMessageBody(input.body, input.chatId),
    botToken: input.credentials?.botToken,
    fetch: input.fetch,
    method: "sendMessage",
  });
  if (!response.ok) {
    throw new Error(`Telegram sendMessage failed with HTTP ${response.status}.`);
  }
  return toTelegramMessageResult(response.body);
}

/**
 * Sends a Telegram chat action (e.g. `typing`) for the given chat. Pass
 * `messageThreadId` to scope the indicator to a forum topic.
 */
export async function sendTelegramChatAction(
  input: TelegramApiOptions & {
    readonly action: string;
    readonly chatId: number | string;
    readonly messageThreadId?: number;
  },
): Promise<TelegramApiResponse> {
  return callTelegramApi({
    apiBaseUrl: input.apiBaseUrl,
    body: parseJsonObject({
      action: input.action,
      chat_id: input.chatId,
      message_thread_id: input.messageThreadId,
    }),
    botToken: input.credentials?.botToken,
    fetch: input.fetch,
    method: "sendChatAction",
  });
}

/** Answers a Telegram callback query so the user's client clears the spinner. */
export async function answerTelegramCallbackQuery(
  input: TelegramApiOptions & {
    readonly callbackQueryId: string;
    readonly showAlert?: boolean;
    readonly text?: string;
  },
): Promise<TelegramApiResponse> {
  return callTelegramApi({
    apiBaseUrl: input.apiBaseUrl,
    body: parseJsonObject({
      callback_query_id: input.callbackQueryId,
      show_alert: input.showAlert,
      text: input.text,
    }),
    botToken: input.credentials?.botToken,
    fetch: input.fetch,
    method: "answerCallbackQuery",
  });
}

/** Edits only the reply markup for one Telegram message. */
export async function editTelegramMessageReplyMarkup(
  input: TelegramApiOptions & {
    readonly chatId: number | string;
    readonly messageId: number | string;
    readonly replyMarkup?: Readonly<Record<string, unknown>>;
  },
): Promise<TelegramApiResponse> {
  return callTelegramApi({
    apiBaseUrl: input.apiBaseUrl,
    body: parseJsonObject({
      chat_id: input.chatId,
      message_id: Number(input.messageId),
      reply_markup: input.replyMarkup,
    }),
    botToken: input.credentials?.botToken,
    fetch: input.fetch,
    method: "editMessageReplyMarkup",
  });
}

/** Resolves Telegram file metadata through `getFile`. */
export async function getTelegramFile(
  input: TelegramApiOptions & {
    readonly fileId: string;
  },
): Promise<{ readonly filePath: string; readonly raw: unknown }> {
  const response = await callTelegramApi({
    apiBaseUrl: input.apiBaseUrl,
    body: { file_id: input.fileId },
    botToken: input.credentials?.botToken,
    fetch: input.fetch,
    method: "getFile",
  });
  if (!response.ok) {
    throw new Error(`Telegram getFile failed with HTTP ${response.status}.`);
  }
  const body = isObject(response.body) ? response.body : {};
  const result = isObject(body.result) ? body.result : {};
  if (typeof result.file_path !== "string" || result.file_path.length === 0) {
    throw new Error("Telegram getFile response did not include result.file_path.");
  }
  return { filePath: result.file_path, raw: response.body };
}

/** Downloads file bytes from Telegram's file endpoint. */
export async function downloadTelegramFile(
  input: TelegramApiOptions & {
    readonly filePath: string;
  },
): Promise<Response> {
  const apiFetch = input.fetch ?? fetch;
  const token = await resolveTelegramBotToken(input.credentials?.botToken);
  return apiFetch(
    `${input.fileBaseUrl ?? input.apiBaseUrl ?? "https://api.telegram.org"}/file/bot${token}/${
      input.filePath
    }`,
  );
}

/** Splits text into chunks Telegram will accept as individual sendMessage calls. */
export function splitTelegramMessageText(text: string): readonly string[] {
  if (text.length <= TELEGRAM_MESSAGE_TEXT_MAX_LENGTH) return [text];

  const chunks: string[] = [];
  let rest = text;
  while (rest.length > TELEGRAM_MESSAGE_TEXT_MAX_LENGTH) {
    let cut = rest.lastIndexOf("\n", TELEGRAM_MESSAGE_TEXT_MAX_LENGTH);
    if (cut <= 0) {
      cut = rest.lastIndexOf(" ", TELEGRAM_MESSAGE_TEXT_MAX_LENGTH);
    }
    if (cut <= 0) cut = TELEGRAM_MESSAGE_TEXT_MAX_LENGTH;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  chunks.push(rest);
  return chunks;
}

function normalizeTelegramMessageBody(
  body: TelegramMessageBody,
  chatId: number | string,
): JsonObject {
  return parseJsonObject({
    ...body,
    chat_id: chatId,
  });
}

function toTelegramMessageResult(body: unknown): TelegramMessageResult {
  const raw = isObject(body) ? body : {};
  const result = isObject(raw.result) ? raw.result : {};
  const chat = isObject(result.chat) ? result.chat : {};
  return {
    chatId:
      typeof chat.id === "number" || typeof chat.id === "string" ? String(chat.id) : undefined,
    id:
      typeof result.message_id === "number" || typeof result.message_id === "string"
        ? String(result.message_id)
        : "",
    raw: body,
  };
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
