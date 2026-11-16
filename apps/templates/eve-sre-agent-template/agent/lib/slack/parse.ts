// Boundary parsing shared by the Slack tools: model-provided strings (IDs,
// mentions, permalinks, timestamps) and raw Slack wire messages become typed
// values here, so each tool stays a thin callSlackApi call site.

const CHANNEL_ID = /^[A-Z0-9]+$/i;
const CHANNEL_MENTION = /^<#([A-Z0-9]+)(?:\|[^>]+)?>$/i;
const CHANNEL_PERMALINK = /\/archives\/([A-Z0-9]+)/i;
const TIMESTAMP = /^\d{10}\.\d{6,}$/;
const TIMESTAMP_PERMALINK = /\/p(\d{10})(\d{6})(?:\?|$)/i;
const USER_ID = /^[UW][A-Z0-9]+$/i;
const USER_MENTION = /^<@([A-Z0-9]+)(?:\|[^>]+)?>$/i;

export function normalizeSlackChannelId(value: string): string {
  const trimmed = value.trim();
  const mentionMatch = CHANNEL_MENTION.exec(trimmed);

  if (mentionMatch) {
    return mentionMatch[1].toUpperCase();
  }

  const permalinkMatch = CHANNEL_PERMALINK.exec(trimmed);

  if (permalinkMatch) {
    return permalinkMatch[1].toUpperCase();
  }

  if (CHANNEL_ID.test(trimmed)) {
    return trimmed.toUpperCase();
  }

  throw new Error(
    `Could not parse a Slack channel ID from "${value}". Pass a channel ID, channel mention, or Slack permalink.`
  );
}

export function normalizeSlackUserId(value: string): string {
  const trimmed = value.trim();
  const mentionMatch = USER_MENTION.exec(trimmed);

  if (mentionMatch) {
    return mentionMatch[1].toUpperCase();
  }

  if (USER_ID.test(trimmed)) {
    return trimmed.toUpperCase();
  }

  throw new Error(
    `Could not parse a Slack user ID from "${value}". Pass a user ID like U12345678 or a user mention like <@U12345678>.`
  );
}

export function normalizeSlackTimestamp(value: string, label: string): string {
  const trimmed = value.trim();
  const permalinkMatch = TIMESTAMP_PERMALINK.exec(trimmed);

  if (permalinkMatch) {
    return `${permalinkMatch[1]}.${permalinkMatch[2]}`;
  }

  if (TIMESTAMP.test(trimmed)) {
    return trimmed;
  }

  throw new Error(
    `Could not parse a Slack message timestamp from "${value}" for ${label}.`
  );
}

export interface CompactSlackMessage {
  botId?: string;
  reactions?: unknown;
  replyCount?: number;
  subtype?: string;
  text: string;
  threadTs?: string;
  ts: string;
  userId?: string;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Project one raw Slack message into the compact shape the model reads. */
export function compactSlackMessage(
  raw: unknown
): CompactSlackMessage | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }

  const message = raw as Record<string, unknown>;
  const ts = asString(message.ts);

  if (!ts) {
    return undefined;
  }

  return {
    botId: asString(message.bot_id),
    reactions: message.reactions,
    replyCount:
      typeof message.reply_count === "number" ? message.reply_count : undefined,
    subtype: asString(message.subtype),
    text: asString(message.text) ?? "",
    threadTs: asString(message.thread_ts),
    ts,
    userId: asString(message.user),
  };
}
