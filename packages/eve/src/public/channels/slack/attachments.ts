import type { FilePart, TextPart, UserContent } from "ai";

import type { FetchFileContext, FetchFileResult } from "#channel/adapter.js";
import { EveAttachmentError } from "#internal/attachments/errors.js";
import { readLimitedBytes } from "#internal/attachments/limited-read.js";
import { createLogger } from "#internal/logging.js";
import {
  resolveSlackBotToken,
  type SlackBotToken,
  type SlackThread,
} from "#public/channels/slack/api.js";
import {
  parseAttachments,
  type SlackAttachment,
  type SlackMessage,
} from "#public/channels/slack/inbound.js";
import {
  isConfiguredSlackFileUrl,
  resolveSlackTransportOptions,
  type SlackTransportOptions,
} from "#public/channels/slack/transport.js";
import {
  evaluateFilePart,
  formatUploadPolicyViolation,
  isUploadsDisabled,
} from "#public/channels/upload-policy.js";
import { DEFAULT_UPLOAD_POLICY, type UploadPolicy } from "#public/channels/upload-policy.js";

const log = createLogger("slack.attachments");

/** Thread messages the lookback inspects, newest first, when a mention carries no files. */
const THREAD_LOOKBACK_MESSAGES = 10;
/** Slack file downloads give up after this long, so one slow file can't stall the turn. */
const FILE_FETCH_TIMEOUT_MS = 30_000;

/**
 * Emits one {@link FilePart} per attachment in the inbound message, with
 * `data` set to a `URL` object pointing at the Slack file. URL-less and
 * policy-violating attachments are dropped so a single bad upload never
 * blocks the text portion.
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
 * Collects file parts for an inbound message.
 *
 * Prefers attachments on the triggering message (the common case: a person
 * uploads a file and mentions the app in the same message). When a mention
 * carries none, refreshes the thread via {@link SlackThread.refresh} and
 * collects, in thread order, the files of the messages between the previous
 * mention of the app and the trigger, up to {@link THREAD_LOOKBACK_MESSAGES}
 * messages back. A trigger the refresh didn't return gets no lookback.
 * That earlier mention started its own turn, which collected the files before
 * it. The app's own messages and remote files are skipped. A message that
 * didn't mention the app gets no lookback: the app answers every message in
 * that conversation, so each earlier message brought its own files.
 *
 * Any error during refresh is logged and treated as "no attachments" so the
 * text portion of the message still gets delivered. Skips the lookback when
 * the policy disables uploads, since the refresh can't surface anything we'd
 * deliver.
 */
export async function collectInboundFileParts(input: {
  readonly mention: Pick<SlackMessage, "attachments" | "ts">;
  readonly thread: SlackThread;
  readonly policy: UploadPolicy;
  /** Whether the triggering message mentions the app. */
  readonly isMentioned: boolean;
  readonly botUserId: string | undefined;
}): Promise<FilePart[]> {
  const fromMention = collectSlackFileParts(input.mention.attachments, input.policy);
  if (fromMention.length > 0 || !input.isMentioned) return fromMention;
  if (isUploadsDisabled(input.policy)) return [];

  if (input.thread.recentMessages.length === 0) {
    try {
      await input.thread.refresh();
    } catch (error) {
      log.warn("slack thread refresh failed for attachment collection", { error });
      return [];
    }
  }

  // Anchor on the trigger: a refresh returns at most the thread's oldest
  // replies, and messages posted after the trigger aren't its files.
  const recent = input.thread.recentMessages;
  const trigger = recent.findIndex((message) => message.ts === input.mention.ts);
  if (trigger === -1) return [];
  const earlier = recent.slice(Math.max(0, trigger - THREAD_LOOKBACK_MESSAGES), trigger);
  const attachments: SlackAttachment[] = [];
  const seen = new Set<string>();
  for (const message of earlier.toReversed()) {
    if (message.isMe) continue;
    if (mentionsApp(message.text, input.botUserId)) break;
    const raw = message.raw as { files?: readonly Record<string, unknown>[] } | undefined;
    const files = parseAttachments(raw?.files).filter(
      (file) => file.id === "" || !seen.has(file.id),
    );
    for (const file of files) seen.add(file.id);
    attachments.unshift(...files);
  }
  return collectSlackFileParts(attachments, input.policy);
}

/** Matches `<@U123>` and the labelled `<@U123|name>` form. */
function mentionsApp(text: string, botUserId: string | undefined): boolean {
  return (
    botUserId !== undefined &&
    (text.includes(`<@${botUserId}>`) || text.includes(`<@${botUserId}|`))
  );
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
 * through to the model provider unchanged. Fetches Slack file URLs, and
 * URLs under a configured `api.fileBaseUrl`, with the bot token, on
 * `api.fetch` when one is configured.
 */
export function createSlackFetchFile(input: {
  readonly api?: SlackTransportOptions;
  readonly botToken?: SlackBotToken;
  /** Downloads stop at this many bytes. Defaults to the framework's 25 MB. */
  readonly maxBytes?: number;
}): (url: string, context?: FetchFileContext) => Promise<FetchFileResult | null> {
  const api = resolveSlackTransportOptions(input.api);
  return async (url, context) => {
    if (!isConfiguredSlackFileUrl(api, url) && !isSlackFileUrl(url)) {
      return null;
    }
    const installationTeamId = context?.state.installationTeamId;
    const token = await resolveSlackBotToken(input.botToken, {
      teamId: typeof installationTeamId === "string" ? installationTeamId : undefined,
    });
    const response = await (api?.fetch ?? fetch)(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FILE_FETCH_TIMEOUT_MS),
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
      bytes: await readLimitedBytes(
        response,
        input.maxBytes ?? DEFAULT_UPLOAD_POLICY.maxBytes,
        "slack",
      ),
      mediaType,
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
