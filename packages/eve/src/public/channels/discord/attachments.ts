import type { FilePart, UserContent } from "ai";

import type { FetchFileResult } from "#channel/adapter.js";
import { EveAttachmentError } from "#internal/attachments/errors.js";
import { readLimitedBytes } from "#internal/attachments/limited-read.js";
import type { DiscordFetch } from "#public/channels/discord/api.js";
import type { DiscordAttachment } from "#public/channels/discord/inbound.js";
import { DEFAULT_UPLOAD_POLICY } from "#public/channels/upload-policy.js";

// Discord serves attachments from signed CDN URLs that need no credentials.
const DISCORD_CDN_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

/**
 * The model-visible content of a command: its prompt, plus one file part per
 * attachment, which the channel's `fetchFile` downloads. Files over the default
 * upload limit become a short note instead.
 */
export function discordCommandContent(
  text: string,
  attachments: readonly DiscordAttachment[],
): string | UserContent {
  if (attachments.length === 0) return text;
  const parts: Exclude<UserContent, string> = text.trim() ? [{ text, type: "text" }] : [];
  for (const attachment of attachments) {
    if (attachment.size !== undefined && attachment.size > DEFAULT_UPLOAD_POLICY.maxBytes) {
      parts.push({
        text: `Attachment ${attachment.filename} was not retrieved: it is over the upload limit.`,
        type: "text",
      });
      continue;
    }
    const file: FilePart = {
      data: new URL(attachment.url),
      filename: attachment.filename,
      mediaType: attachment.contentType ?? "application/octet-stream",
      type: "file",
    };
    parts.push(file);
  }
  return parts;
}

/**
 * Creates the channel's `fetchFile` for Discord CDN URLs. Any other URL
 * resolves to `null`, so it's never fetched here.
 */
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
      // Discord's reported size can be wrong, so the download itself stops at the limit too.
      bytes: await readLimitedBytes(response, DEFAULT_UPLOAD_POLICY.maxBytes, "discord"),
      mediaType: response.headers.get("content-type") ?? undefined,
    };
  };
}
