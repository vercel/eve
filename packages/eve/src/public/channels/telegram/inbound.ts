/**
 * Inbound Telegram update parsing and prompt shaping.
 *
 * The channel defines small, documented data shapes and does not return
 * Telegram's raw webhook payloads as the public API.
 */

import { isNonEmptyString, isObject } from "#shared/guards.js";

/**
 * Telegram chat types the channel recognizes. Note: the channel parses
 * `channel` updates but never dispatches them to the agent.
 */
export type TelegramChatType = "channel" | "group" | "private" | "supergroup";

/** Telegram user metadata that inbound messages and callbacks carry. */
export interface TelegramUser {
  readonly firstName?: string;
  readonly id: string;
  readonly isBot: boolean;
  readonly languageCode?: string;
  readonly lastName?: string;
  readonly username?: string;
}

/** Telegram chat metadata that inbound messages carry. */
export interface TelegramChat {
  readonly id: string;
  readonly title?: string;
  readonly type: TelegramChatType;
  readonly username?: string;
}

/** Inbound Telegram file attachment. */
export interface TelegramAttachment {
  readonly fileId: string;
  readonly fileName?: string;
  readonly fileUniqueId?: string;
  readonly height?: number;
  readonly kind: "document" | "photo";
  readonly mediaType?: string;
  readonly size?: number;
  readonly width?: number;
}

/** Minimal Telegram message representation nested on replies/callbacks. */
export interface TelegramMessageReference {
  readonly chat: TelegramChat;
  readonly from?: TelegramUser;
  readonly messageId: string;
  readonly messageThreadId?: number;
}

/**
 * Channel-owned representation of one inbound Telegram message. `text` and
 * `caption` default to `""` (never undefined), and `attachments` is always an
 * array (possibly empty).
 */
export interface TelegramMessage {
  readonly attachments: readonly TelegramAttachment[];
  readonly caption: string;
  readonly chat: TelegramChat;
  readonly from?: TelegramUser;
  readonly messageId: string;
  readonly messageThreadId?: number;
  readonly raw: Record<string, unknown>;
  readonly replyToMessage?: TelegramMessageReference;
  readonly text: string;
}

/** Channel-owned representation of one inbound Telegram callback query. */
export interface TelegramCallbackQuery {
  readonly data?: string;
  readonly from: TelegramUser;
  readonly id: string;
  readonly message?: TelegramMessageReference;
  readonly raw: Record<string, unknown>;
}

/**
 * Discriminated union of inbound updates the channel handles. Switch on `kind`:
 * `"message"` carries `message`, `"callback_query"` carries `callbackQuery`.
 */
export type TelegramUpdate =
  | { readonly kind: "callback_query"; readonly callbackQuery: TelegramCallbackQuery }
  | { readonly kind: "message"; readonly message: TelegramMessage };

const TELEGRAM_RESPONSE_INSTRUCTIONS =
  "Reply for Telegram in concise plain text. Avoid tables, long code fences, " +
  "and formatting that depends on Markdown rendering.";

/**
 * Inbound identity and response guidance that {@link formatTelegramContextBlock}
 * renders into the model-visible context block.
 */
export interface TelegramInboundContext {
  readonly botUsername?: string;
  readonly chatId: string;
  readonly chatTitle?: string;
  readonly chatType: TelegramChatType;
  readonly messageId: string;
  readonly messageThreadId?: number;
  readonly userId?: string;
  readonly username?: string;
}

/** Parses one JSON-decoded Telegram update payload. */
export function parseTelegramUpdate(value: unknown): TelegramUpdate | null {
  if (!isObject(value)) return null;

  const message = parseTelegramMessage(value.message);
  if (message !== null) return { kind: "message", message };

  const callbackQuery = parseTelegramCallbackQuery(value.callback_query);
  if (callbackQuery !== null) return { callbackQuery, kind: "callback_query" };

  return null;
}

/**
 * Renders one {@link TelegramInboundContext} as a deterministic
 * `<telegram_context>` block with fixed response instructions and the chat and
 * user identity fields.
 */
export function formatTelegramContextBlock(context: TelegramInboundContext): string {
  const lines = [
    "<telegram_context>",
    "response_medium: telegram",
    `response_instructions: ${TELEGRAM_RESPONSE_INSTRUCTIONS}`,
    `chat_id: ${context.chatId}`,
    `chat_type: ${context.chatType}`,
    ...(context.chatTitle ? [`chat_title: ${context.chatTitle}`] : []),
    `message_id: ${context.messageId}`,
    ...(context.messageThreadId !== undefined
      ? [`message_thread_id: ${context.messageThreadId}`]
      : []),
    ...(context.userId ? [`user_id: ${context.userId}`] : []),
    ...(context.username ? [`username: ${context.username}`] : []),
    ...(context.botUsername ? [`bot_username: ${context.botUsername}`] : []),
    "</telegram_context>",
  ];
  return lines.join("\n");
}

function parseTelegramMessage(value: unknown): TelegramMessage | null {
  if (!isObject(value)) return null;
  const chat = parseTelegramChat(value.chat);
  const messageId = numberLikeToString(value.message_id);
  if (!chat || !messageId) return null;

  return {
    attachments: parseAttachments(value),
    caption: typeof value.caption === "string" ? value.caption : "",
    chat,
    from: parseTelegramUser(value.from),
    messageId,
    messageThreadId:
      typeof value.message_thread_id === "number" ? value.message_thread_id : undefined,
    raw: value,
    replyToMessage: parseMessageReference(value.reply_to_message),
    text: typeof value.text === "string" ? value.text : "",
  };
}

function parseTelegramCallbackQuery(value: unknown): TelegramCallbackQuery | null {
  if (!isObject(value) || !isNonEmptyString(value.id)) return null;
  const from = parseTelegramUser(value.from);
  if (!from) return null;
  return {
    data: typeof value.data === "string" ? value.data : undefined,
    from,
    id: value.id,
    message: parseMessageReference(value.message),
    raw: value,
  };
}

function parseMessageReference(value: unknown): TelegramMessageReference | undefined {
  if (!isObject(value)) return undefined;
  const chat = parseTelegramChat(value.chat);
  const messageId = numberLikeToString(value.message_id);
  if (!chat || !messageId) return undefined;
  return {
    chat,
    from: parseTelegramUser(value.from),
    messageId,
    messageThreadId:
      typeof value.message_thread_id === "number" ? value.message_thread_id : undefined,
  };
}

function parseTelegramChat(value: unknown): TelegramChat | null {
  if (!isObject(value)) return null;
  const id = numberLikeToString(value.id);
  const type = parseTelegramChatType(value.type);
  if (!id || !type) return null;
  return {
    id,
    title: typeof value.title === "string" ? value.title : undefined,
    type,
    username: typeof value.username === "string" ? value.username : undefined,
  };
}

function parseTelegramUser(value: unknown): TelegramUser | undefined {
  if (!isObject(value)) return undefined;
  const id = numberLikeToString(value.id);
  if (!id) return undefined;
  return {
    firstName: typeof value.first_name === "string" ? value.first_name : undefined,
    id,
    isBot: value.is_bot === true,
    languageCode: typeof value.language_code === "string" ? value.language_code : undefined,
    lastName: typeof value.last_name === "string" ? value.last_name : undefined,
    username: typeof value.username === "string" ? value.username : undefined,
  };
}

function parseAttachments(value: Record<string, unknown>): TelegramAttachment[] {
  const attachments: TelegramAttachment[] = [];

  const photo = parseLargestPhoto(value.photo);
  if (photo !== null) attachments.push(photo);

  const document = parseDocument(value.document);
  if (document !== null) attachments.push(document);

  return attachments;
}

function parseLargestPhoto(value: unknown): TelegramAttachment | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const photos = value
    .filter(isObject)
    .map((photo) => ({
      fileId: typeof photo.file_id === "string" ? photo.file_id : "",
      fileUniqueId: typeof photo.file_unique_id === "string" ? photo.file_unique_id : undefined,
      height: typeof photo.height === "number" ? photo.height : undefined,
      size: typeof photo.file_size === "number" ? photo.file_size : undefined,
      width: typeof photo.width === "number" ? photo.width : undefined,
    }))
    .filter((photo) => photo.fileId.length > 0)
    .sort((a, b) => scorePhoto(b) - scorePhoto(a));
  const selected = photos[0];
  if (!selected) return null;
  return {
    fileId: selected.fileId,
    fileName: "photo.jpg",
    fileUniqueId: selected.fileUniqueId,
    height: selected.height,
    kind: "photo",
    mediaType: "image/jpeg",
    size: selected.size,
    width: selected.width,
  };
}

function parseDocument(value: unknown): TelegramAttachment | null {
  if (!isObject(value) || typeof value.file_id !== "string") return null;
  return {
    fileId: value.file_id,
    fileName: typeof value.file_name === "string" ? value.file_name : undefined,
    fileUniqueId: typeof value.file_unique_id === "string" ? value.file_unique_id : undefined,
    kind: "document",
    mediaType: typeof value.mime_type === "string" ? value.mime_type : undefined,
    size: typeof value.file_size === "number" ? value.file_size : undefined,
  };
}

function scorePhoto(photo: {
  readonly height?: number;
  readonly size?: number;
  readonly width?: number;
}) {
  if (photo.size !== undefined) return photo.size;
  return (photo.width ?? 0) * (photo.height ?? 0);
}

/** Parses the Telegram chat types eve recognizes from inbound and send responses. */
export function parseTelegramChatType(value: unknown): TelegramChatType | null {
  if (value === "channel" || value === "group" || value === "private" || value === "supergroup") {
    return value;
  }
  return null;
}

function numberLikeToString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}
