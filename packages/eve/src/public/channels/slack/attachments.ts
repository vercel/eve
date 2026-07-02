import type { FilePart, TextPart, UserContent } from "ai";

import type { FetchFileResult } from "#channel/adapter.js";
import { createLogger } from "#internal/logging.js";
import {
  resolveSlackBotToken,
  type SlackBotToken,
  type SlackThread,
} from "#public/channels/slack/api.js";
import type { SlackAttachment, SlackMessage } from "#public/channels/slack/inbound.js";
import {
  evaluateFilePart,
  formatUploadPolicyViolation,
  isUploadsDisabled,
} from "#public/channels/upload-policy.js";
import type { UploadPolicy } from "#public/channels/upload-policy.js";

const log = createLogger("slack.attachments");

/**
 * Emits one {@link FilePart} per supported attachment in the inbound
 * message, with `data` set to a `URL` object pointing at the Slack
 * file. Audio, video, URL-less, and policy-violating attachments are
 * dropped so a single bad upload never blocks the text portion.
 *
 * The `URL` object in `data` is resolved by the channel's `fetchFile`
 * function at staging time inside the workflow step.
 */
export function collectSlackFileParts(
  attachments: readonly SlackAttachment[] | undefined,
  policy: UploadPolicy,
): FilePart[] {
  const parts: FilePart[] = [];
  for (const attachment of attachments ?? []) {
    const part = toSlackFilePart(attachment, parts.length);
    if (part === null) continue;

    const violation = evaluateFilePart(part, policy);
    if (violation !== null) {
      log.warn(`dropped attachment — ${formatUploadPolicyViolation(violation)}`, {
        name: attachment.name,
      });
      continue;
    }
    parts.push(part);
  }
  return parts;
}

function toSlackFilePart(attachment: SlackAttachment, index: number): FilePart | null {
  if (attachment.type === "audio" || attachment.type === "video") {
    return null;
  }
  if (!attachment.url) {
    log.warn("dropped attachment — no url available", {
      name: attachment.name,
    });
    return null;
  }

  return {
    type: "file",
    mediaType: attachment.mimeType ?? "application/octet-stream",
    filename: attachment.name ?? `attachment-${index}`,
    data: new URL(attachment.url),
  };
}

/**
 * Collects file parts for an inbound mention.
 *
 * Prefers attachments on the triggering mention (the common case: user
 * uploads a file and mentions the bot in the same message). When the
 * mention has none, refreshes the thread via {@link SlackThread.refresh}
 * and picks the latest non-bot message's attachments — covering the
 * case where a user dropped a file in the thread first, then mentioned
 * the bot in a follow-up. Any error during refresh is logged and treated
 * as "no attachments" so the text portion of the mention still gets
 * delivered.
 *
 * Skips the thread-history lookback when the policy disables uploads,
 * since the refresh can't surface anything we'd deliver.
 */
export async function collectInboundFileParts(input: {
  readonly mention: Pick<SlackMessage, "attachments">;
  readonly thread: SlackThread;
  readonly policy: UploadPolicy;
}): Promise<FilePart[]> {
  const fromMention = collectSlackFileParts(input.mention.attachments, input.policy);
  if (fromMention.length > 0) return fromMention;
  if (isUploadsDisabled(input.policy)) return [];

  if (input.thread.recentMessages.length === 0) {
    try {
      await input.thread.refresh();
    } catch (error) {
      log.warn("slack thread refresh failed for attachment collection", { error });
      return [];
    }
  }

  const recent = input.thread.recentMessages;
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const candidate = recent[i];
    if (!candidate || candidate.isMe) continue;
    const raw = candidate.raw as { files?: readonly Record<string, unknown>[] } | undefined;
    const attachments = extractAttachmentsFromRaw(raw?.files);
    const parts = collectSlackFileParts(attachments, input.policy);
    if (parts.length > 0) return parts;
    return [];
  }
  return [];
}

function extractAttachmentsFromRaw(
  files: readonly Record<string, unknown>[] | undefined,
): SlackAttachment[] {
  if (!Array.isArray(files)) return [];
  return files.map((file) => {
    const mimeType = typeof file.mimetype === "string" ? file.mimetype : undefined;
    return {
      id: typeof file.id === "string" ? file.id : "",
      type: inferAttachmentType(mimeType),
      url: typeof file.url_private === "string" ? file.url_private : undefined,
      name: typeof file.name === "string" ? file.name : undefined,
      mimeType,
      size: typeof file.size === "number" ? file.size : undefined,
    };
  });
}

function inferAttachmentType(mimeType: string | undefined): "image" | "file" | "video" | "audio" {
  if (mimeType === undefined) return "file";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "file";
}

/**
 * Combines text + file parts into the {@link UserContent} shape the
 * harness expects. Returns the raw text string when there are no
 * parts (the common path).
 */
export function buildSlackTurnMessage(
  text: string,
  fileParts: readonly FilePart[],
): string | UserContent {
  if (fileParts.length === 0) {
    return text;
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return [...fileParts];
  }
  const textPart: TextPart = { type: "text", text };
  return [textPart, ...fileParts];
}

/**
 * Creates a `fetchFile` function for the Slack channel.
 *
 * Returns `null` for URLs that don't belong to Slack so they pass
 * through to the model provider unchanged. Fetches Slack file URLs
 * with the bot token.
 */
export function createSlackFetchFile(input: {
  readonly botToken?: SlackBotToken;
}): (url: string) => Promise<FetchFileResult | null> {
  return async (url) => {
    if (!isSlackFileUrl(url)) {
      return null;
    }
    const token = await resolveSlackBotToken(input.botToken);
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(`Slack file fetch returned HTTP ${response.status} for ${url}.`);
    }
    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      mediaType: response.headers.get("content-type") ?? undefined,
    };
  };
}

function isSlackFileUrl(url: string): boolean {
  const parsed = URL.parse(url);
  if (parsed?.protocol !== "https:") {
    return false;
  }
  if (parsed.hostname === "files.slack.com") {
    return true;
  }
  return (
    (parsed.hostname === "enterprise.slack.com" ||
      parsed.hostname.endsWith(".enterprise.slack.com")) &&
    parsed.pathname.startsWith("/files/")
  );
}
