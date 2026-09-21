import type { FilePart, TextPart, UserContent } from "ai";

import type { FetchFileContext, FetchFileResult } from "#channel/adapter.js";
import { EveAttachmentError } from "#internal/attachments/errors.js";
import { createLogger } from "#internal/logging.js";
import { type SlackThread } from "#public/channels/slack/api.js";
import {
  resolveSlackApiUrl,
  resolveSlackBotToken,
  resolveSlackFetch,
  type SlackApiConfig,
  type SlackBotToken,
} from "#public/channels/slack/api-transport.js";
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
 * and picks the attachments of the latest message this app did not
 * author (the thread message `isMe` classification) — covering the case
 * where a user or another bot dropped a file in the thread first, then a
 * user mentioned the bot in a follow-up. Any error during refresh is logged
 * and treated as "no attachments" so the text portion of the mention
 * still gets delivered.
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
  readonly api?: SlackApiConfig;
}): (url: string, context?: FetchFileContext) => Promise<FetchFileResult | null> {
  return async (url, context) => {
    if (!isSlackFileUrl(url, input.api)) {
      return null;
    }
    const installationTeamId = context?.state.installationTeamId;
    const token = await resolveSlackBotToken(input.botToken, {
      teamId: typeof installationTeamId === "string" ? installationTeamId : undefined,
    });
    const response = await resolveSlackFetch(input.api)(url, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new EveAttachmentError({
        adapterKind: "slack",
        kind: "resolver-threw",
        message: `Slack file fetch returned HTTP ${response.status}.`,
      });
    }
    const mediaType = response.headers.get("content-type") ?? undefined;
    const normalizedMediaType = mediaType?.split(";", 1)[0]?.trim().toLowerCase();
    if (normalizedMediaType === "text/html") {
      throw new EveAttachmentError({
        adapterKind: "slack",
        kind: "resolver-threw",
        message:
          "Slack returned an HTML sign-in page instead of file bytes. The bot token may be missing the files:read scope. Add the scope, reinstall the Slack app, and retry.",
      });
    }
    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      mediaType,
    };
  };
}

/**
 * Whether an attachment URL is one eve downloads with the bot token.
 *
 * Slack's own file hosts are always accepted. A configured
 * {@link SlackApiConfig.url} additionally allows that origin, so a Slack
 * simulator can serve its own `url_private` files — including over
 * `http:` on localhost, which the Slack hosts never get.
 */
function isSlackFileUrl(url: string, api?: SlackApiConfig): boolean {
  const parsed = URL.parse(url);
  if (parsed === null) {
    return false;
  }
  if (matchesConfiguredSlackApiOrigin(parsed, api)) {
    return true;
  }
  if (parsed.protocol !== "https:") {
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

function matchesConfiguredSlackApiOrigin(parsed: URL, api?: SlackApiConfig): boolean {
  // Only an explicit override widens the allowlist; the Slack default is
  // already covered by the file hosts above.
  if ((api?.url ?? process.env.SLACK_API_URL) === undefined) return false;
  const configured = URL.parse(resolveSlackApiUrl(api));
  if (configured === null || configured.origin === "null") return false;
  return parsed.origin === configured.origin;
}
