import type { MessageContent, MessageFilePart, MessagePart } from "#shared/message-content.js";

import type { FetchFileResult } from "#channel/adapter.js";
import { EveAttachmentError } from "#internal/attachments/errors.js";
import { readLimitedBytes } from "#internal/attachments/limited-read.js";
import type { DiscordFetch } from "#public/channels/discord/api.js";
import type { DiscordAttachment } from "#public/channels/discord/inbound.js";
import { DEFAULT_UPLOAD_POLICY } from "#public/channels/upload-policy.js";

const DISCORD_CDN_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

export function discordCommandContent(
  text: string,
  attachments: readonly DiscordAttachment[],
): MessageContent {
  if (attachments.length === 0) return text;
  const parts: MessagePart[] = text.trim() ? [{ text, type: "text" }] : [];
  for (const attachment of attachments) {
    if (attachment.size !== undefined && attachment.size > DEFAULT_UPLOAD_POLICY.maxBytes) {
      parts.push({
        text: `Attachment ${attachment.filename} was not retrieved: it is over the upload limit.`,
        type: "text",
      });
      continue;
    }
    const file: MessageFilePart = {
      data: new URL(attachment.url),
      filename: attachment.filename,
      mediaType: attachment.contentType ?? "application/octet-stream",
      type: "file",
    };
    parts.push(file);
  }
  return parts;
}

export function createDiscordFetchFile(
  fetchImpl: DiscordFetch = fetch,
): (url: string) => Promise<FetchFileResult | null> {
  return async (url) => {
    const parsed = URL.parse(url);
    if (parsed?.protocol !== "https:" || !DISCORD_CDN_HOSTS.has(parsed.hostname)) return null;
    const response = await fetchImpl(url, { redirect: "error" });
    if (!response.ok) {
      throw new EveAttachmentError({
        adapterKind: "discord",
        kind: "resolver-threw",
        message: `Discord file fetch returned HTTP ${response.status}.`,
      });
    }
    return {
      bytes: await readLimitedBytes(response, DEFAULT_UPLOAD_POLICY.maxBytes, "discord"),
      mediaType: response.headers.get("content-type") ?? undefined,
    };
  };
}
