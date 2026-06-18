/**
 * Blooio inbound webhook parsing and prompt shaping.
 *
 * The channel owns these small data shapes instead of exposing raw
 * Blooio webhook payloads as the public API surface. See the Blooio
 * `message.received` event schema.
 */

/** One inbound attachment as delivered by a Blooio webhook. */
export interface BlooioInboundAttachment {
  /** Public URL of the file (Blooio serves inbound media from a public bucket). */
  readonly url?: string;
  /** Display file name (`file_name` in the webhook payload). */
  readonly name?: string;
  /** MIME type (`mime_type` in the webhook payload). */
  readonly mimeType?: string;
  readonly size?: number;
  readonly [key: string]: unknown;
}

/** Threaded-reply parent reference, present only on inline-reply inbounds. */
export interface BlooioReplyTo {
  readonly messageId?: string;
  readonly guid?: string;
  readonly partIndex?: number;
}

/** Channel-owned representation of one inbound Blooio message. */
export interface BlooioInboundMessage {
  /** Blooio message ID (`msg_...`). */
  readonly messageId: string | undefined;
  /** Who sent the message: phone (E.164) or email. */
  readonly sender: string;
  /** The Blooio device/number that received the message (our line). */
  readonly internalId: string | undefined;
  /** Reply target: the group ID for group chats, otherwise the sender. */
  readonly chatId: string;
  readonly text: string;
  readonly attachments: readonly BlooioInboundAttachment[];
  readonly protocol: string | undefined;
  readonly isGroup: boolean;
  readonly groupId: string | undefined;
  readonly groupName: string | undefined;
  readonly participants: readonly string[] | undefined;
  readonly replyTo: BlooioReplyTo | undefined;
  readonly receivedAt: number | undefined;
  /** The raw parsed webhook payload. */
  readonly raw: Record<string, unknown>;
}

const BLOOIO_RESPONSE_INSTRUCTIONS =
  "Reply in plain text suitable for iMessage/SMS. Keep the response concise and avoid Markdown " +
  "formatting, tables, headings, code fences, and long lists. Ask at most one short follow-up " +
  "question when more information is needed.";

/**
 * Parses a Blooio webhook payload into a {@link BlooioInboundMessage}.
 *
 * Returns `null` for payloads that are not inbound `message.received`
 * events, or that lack a sender. Delivery-status events
 * (`message.sent`, `message.delivered`, etc.) are intentionally ignored.
 */
export function parseBlooioInboundMessage(payload: unknown): BlooioInboundMessage | null {
  if (!isRecord(payload)) return null;
  if (payload.event !== "message.received") return null;

  const isGroup = payload.is_group === true;
  const sender = readString(payload.sender) ?? readString(payload.external_id);
  const groupId = readString(payload.group_id);
  const chatId = isGroup ? groupId : sender;
  if (!chatId) return null;

  return {
    attachments: readAttachments(payload.attachments),
    chatId,
    groupId,
    groupName: readString(payload.group_name),
    internalId: readString(payload.internal_id),
    isGroup,
    messageId: readString(payload.message_id),
    participants: readStringArray(payload.participants),
    protocol: readString(payload.protocol),
    raw: payload,
    receivedAt: readNumber(payload.received_at) ?? readNumber(payload.timestamp),
    replyTo: readReplyTo(payload.reply_to),
    sender: sender ?? chatId,
    text: readString(payload.text) ?? "",
  };
}

/** Renders a deterministic `<blooio_context>` block for the model. */
export function formatBlooioContextBlock(message: BlooioInboundMessage): string {
  const lines = [
    "<blooio_context>",
    `channel: ${message.isGroup ? "group" : "direct"}`,
    "response_medium: imessage",
    `response_instructions: ${BLOOIO_RESPONSE_INSTRUCTIONS}`,
    `from: ${message.sender}`,
    ...(message.internalId ? [`to: ${message.internalId}`] : []),
    ...(message.protocol ? [`protocol: ${message.protocol}`] : []),
    ...(message.messageId ? [`message_id: ${message.messageId}`] : []),
    ...(message.isGroup && message.groupId ? [`group_id: ${message.groupId}`] : []),
    ...(message.isGroup && message.groupName ? [`group_name: ${message.groupName}`] : []),
    ...(message.attachments.length > 0 ? [`attachments: ${message.attachments.length}`] : []),
    ...(message.replyTo?.messageId ? [`reply_to: ${message.replyTo.messageId}`] : []),
    "</blooio_context>",
  ];
  return lines.join("\n");
}

function readReplyTo(value: unknown): BlooioReplyTo | undefined {
  if (!isRecord(value)) return undefined;
  const messageId = readString(value.message_id);
  const guid = readString(value.guid);
  const partIndex = readNumber(value.part_index);
  if (messageId === undefined && guid === undefined && partIndex === undefined) return undefined;
  return { guid, messageId, partIndex };
}

function readAttachments(value: unknown): BlooioInboundAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (typeof entry === "string") return { url: entry };
    if (!isRecord(entry)) return {};
    return {
      ...entry,
      url: readString(entry.url),
      name: readString(entry.file_name) ?? readString(entry.name),
      mimeType: readString(entry.mime_type) ?? readString(entry.mimeType),
      size: readNumber(entry.size),
    };
  });
}

const EXTENSION_MEDIA_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  bmp: "image/bmp",
  tiff: "image/tiff",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  avi: "video/x-msvideo",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  aac: "audio/aac",
  m4a: "audio/mp4",
  caf: "audio/x-caf",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  vcf: "text/vcard",
  json: "application/json",
  zip: "application/zip",
};

/**
 * Best-effort MIME type for an attachment: prefers the explicit
 * `mimeType`, then infers from the URL extension, then falls back to
 * `application/octet-stream`.
 */
export function resolveAttachmentMediaType(attachment: BlooioInboundAttachment): string {
  if (attachment.mimeType) return attachment.mimeType;
  const url = attachment.url;
  if (url) {
    const path = url.split(/[?#]/, 1)[0] ?? url;
    const ext = path.split(".").pop()?.toLowerCase();
    if (ext && EXTENSION_MEDIA_TYPES[ext]) return EXTENSION_MEDIA_TYPES[ext];
  }
  return "application/octet-stream";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((entry): entry is string => typeof entry === "string");
  return items.length > 0 ? items : undefined;
}
