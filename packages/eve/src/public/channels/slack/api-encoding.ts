/**
 * The wire shapes of a Slack call: eve's outbound values encoded into what the
 * vendored transport takes, and Slack's request encodings read back.
 */

import type {
  SlackApiOptions,
  SlackFileUpload,
  SlackMessageOptions,
} from "#compiled/@chat-adapter/slack/api.js";
import { isCardElement, type CardElement, type FileUpload } from "#compiled/chat/index.js";
import type { SlackPostInput } from "#public/channels/slack/api.js";
import { cardToBlocks, cardToFallbackText } from "#public/channels/slack/blocks.js";

export function encodeSlackApiBody(body: unknown): {
  readonly body: string;
  readonly contentType: string;
} {
  const params = new URLSearchParams();
  if (body && typeof body === "object") {
    for (const [key, value] of Object.entries(body)) {
      if (value === undefined || value === null) continue;
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        params.set(key, String(value));
      } else {
        params.set(key, JSON.stringify(value));
      }
    }
  }
  return {
    body: params.toString(),
    contentType: "application/x-www-form-urlencoded",
  };
}

export function decodeSlackApiBody(body: unknown, contentType: string | null): unknown {
  if (typeof body !== "string") return body;
  if (contentType?.includes("application/json")) return parseJson(body);
  if (!contentType?.includes("application/x-www-form-urlencoded")) return body;

  const parsed: Record<string, unknown> = {};
  for (const [key, value] of new URLSearchParams(body)) {
    parsed[key] = value.startsWith("[") || value.startsWith("{") ? parseJson(value) : value;
  }
  return parsed;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Coerces the ergonomic bare forms of `SlackThread.post` / `postEphemeral`
 * into the explicit {@link SlackPostInput} discriminated union the
 * implementation works with.
 *
 * - `string` → `{ markdown }` so call sites like `ctx.thread.post(event.message)`
 *   render through Slack's markdown converter.
 * - {@link CardElement} → `{ card }` so call sites like
 *   `ctx.thread.post(Card({...}))` go through the Block Kit converter.
 * - Anything else is assumed to already be a {@link SlackPostInput}.
 */
export function normalizePostInput(message: string | CardElement | SlackPostInput): SlackPostInput {
  if (typeof message === "string") return { markdown: message };
  if (isCardElement(message)) return { card: message };
  return message;
}

export function buildPostMessageOptions(
  message: SlackPostInput,
  channelId: string,
  threadTs: string,
  apiOptions: SlackApiOptions,
): SlackMessageOptions {
  const base: SlackMessageOptions = {
    ...apiOptions,
    channel: channelId,
    threadTs: threadTs || undefined,
    unfurlLinks: false,
    unfurlMedia: false,
  };

  if ("card" in message) {
    base.blocks = cardToBlocks(message.card);
    base.text = message.fallbackText ?? cardToFallbackText(message.card);
    return base;
  }
  if ("blocks" in message) {
    base.blocks = [...message.blocks];
    if (message.text !== undefined) base.text = message.text;
    return base;
  }
  if ("markdown" in message) {
    base.markdownText = message.markdown;
    return base;
  }
  base.text = message.text;
  return base;
}

export function normalizeSlackApiBody(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return {};
}

export function toSlackFileUpload(file: FileUpload, snippetType?: string): SlackFileUpload {
  return {
    data: normalizeFileData(file.data),
    filename: file.filename,
    snippetType,
  };
}

export function normalizeFileData(data: FileUpload["data"]): SlackFileUpload["data"] {
  if (data instanceof ArrayBuffer) return data;
  if (typeof Blob !== "undefined" && data instanceof Blob) return data;
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  return data;
}
