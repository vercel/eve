import type { MessageContent, MessageFilePart, MessageTextPart } from "#shared/message-content.js";

import type { FetchFileContext, FetchFileResult } from "#channel/adapter.js";
import { EveAttachmentError } from "#internal/attachments/errors.js";
import { readLimitedBytes } from "#internal/attachments/limited-read.js";
import { createLogger } from "#internal/logging.js";
import {
  resolveSlackBotToken,
  THREAD_REFRESH_LIMIT,
  type SlackBotToken,
  type SlackThread,
  type SlackThreadMessage,
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

const THREAD_LOOKBACK_MESSAGES = 10;
const FILE_FETCH_TIMEOUT_MS = 30_000;

export function collectSlackFileParts(
  attachments: readonly SlackAttachment[] | undefined,
  policy: UploadPolicy,
): MessageFilePart[] {
  const parts: MessageFilePart[] = [];
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

function toSlackFilePart(attachment: SlackAttachment, index: number): MessageFilePart | null {
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

export async function collectInboundFileParts(input: {
  readonly mention: Pick<SlackMessage, "attachments" | "threadTs" | "ts">;
  readonly thread: SlackThread;
  readonly policy: UploadPolicy;
  readonly isMentioned: boolean;
  readonly botUserId: string | undefined;
  readonly fetchThreadWindow?: (
    latest: string,
    size: number,
  ) => Promise<readonly SlackThreadMessage[] | undefined>;
}): Promise<MessageFilePart[]> {
  const fromMention = collectSlackFileParts(input.mention.attachments, input.policy);
  if (fromMention.length > 0 || !input.isMentioned) return fromMention;
  if (isUploadsDisabled(input.policy)) return [];
  if (input.mention.threadTs === input.mention.ts) return [];

  if (input.thread.recentMessages.length === 0) {
    try {
      await input.thread.refresh();
    } catch (error) {
      log.warn("slack thread refresh failed for attachment collection", { error });
      return [];
    }
  }

  const recent = await withTrigger(input);
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

async function withTrigger(input: {
  readonly mention: Pick<SlackMessage, "ts">;
  readonly thread: SlackThread;
  readonly fetchThreadWindow?: (
    latest: string,
    size: number,
  ) => Promise<readonly SlackThreadMessage[] | undefined>;
}): Promise<readonly SlackThreadMessage[]> {
  const cached = input.thread.recentMessages;
  if (cached.some((message) => message.ts === input.mention.ts)) return cached;
  if (input.fetchThreadWindow === undefined || cached.length < THREAD_REFRESH_LIMIT) return [];
  try {
    return (await input.fetchThreadWindow(input.mention.ts, THREAD_LOOKBACK_MESSAGES + 1)) ?? [];
  } catch (error) {
    log.warn("slack thread window fetch failed for attachment collection", { error });
    return [];
  }
}

function mentionsApp(text: string, botUserId: string | undefined): boolean {
  return (
    botUserId !== undefined &&
    (text.includes(`<@${botUserId}>`) || text.includes(`<@${botUserId}|`))
  );
}

export function buildSlackTurnMessage(
  text: string,
  fileParts: readonly MessageFilePart[],
): MessageContent {
  if (fileParts.length === 0) {
    return text;
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return [...fileParts];
  }
  const textPart: MessageTextPart = { type: "text", text };
  return [textPart, ...fileParts];
}

export function createSlackFetchFile(input: {
  readonly api?: SlackTransportOptions;
  readonly botToken?: SlackBotToken;
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
