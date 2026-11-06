import type { SlackApiResponse } from "eve/channels/slack";

import { resolveSlackInboundMrkdwn } from "#public/channels/slack/inbound-content.js";

/** One Slack Web API call made with the bot token. Resolves to Slack's raw JSON. */
export type SlackRequest = (
  operation: string,
  body: Record<string, unknown>,
) => Promise<SlackApiResponse>;

/** A Slack response with `ok: false`, carrying Slack's error code. */
export class SlackCallError extends Error {
  readonly code: string;

  constructor(operation: string, response: SlackApiResponse) {
    const code = response.error ?? "unknown_error";
    super(slackErrorMessage(operation, code, response));
    this.name = "SlackCallError";
    this.code = code;
  }
}

function slackErrorMessage(operation: string, code: string, response: SlackApiResponse): string {
  switch (code) {
    case "missing_scope":
      return `Slack ${operation} needs a bot token scope the app does not have (needed: ${response.needed ?? "unknown"}). Add the scope to the Slack app and reinstall it.`;
    case "ratelimited":
      return `Slack rate limited ${operation}. Wait before calling it again.`;
    default:
      return `Slack ${operation} failed: ${code}.`;
  }
}

async function call(
  request: SlackRequest,
  operation: string,
  body: Record<string, unknown>,
): Promise<SlackApiResponse & Record<string, unknown>> {
  const response = await request(operation, body);
  if (response.ok !== true) throw new SlackCallError(operation, response);
  return response as SlackApiResponse & Record<string, unknown>;
}

function slackErrorCode(error: unknown): string | undefined {
  return error instanceof SlackCallError ? error.code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function nextCursor(response: Record<string, unknown>): string | undefined {
  const metadata = response.response_metadata;
  return isRecord(metadata) ? str(metadata.next_cursor) : undefined;
}

// ---------------------------------------------------------------------------
// Search

export interface SlackSearchInput {
  readonly query: string;
  /** The `action_token` of the Slack message that started the turn. */
  readonly actionToken: string;
  readonly limit?: number;
  /** One calendar day, `YYYY-MM-DD`. */
  readonly onDate?: string;
  readonly cursor?: string;
}

export interface SlackSearchMatch {
  readonly channelId?: string;
  readonly channelName?: string;
  readonly ts?: string;
  readonly authorUserId?: string;
  readonly authorName?: string;
  readonly isBot?: boolean;
  readonly text: string;
  readonly permalink?: string;
  readonly replyCount?: number;
}

export type SlackSearchOutcome =
  | {
      readonly query: string;
      readonly matches: readonly SlackSearchMatch[];
      readonly nextCursor?: string;
    }
  | { readonly query: string; readonly tokenExpired: true };

/** Replaces any date filter in the query with Slack's exact-day `on:` filter. */
export function slackSearchQuery(query: string, onDate: string | undefined): string {
  if (!onDate) return query;
  const stripped = query
    .replace(/(?:^|\s)(?:after|before|during|on):\d{4}-\d{2}-\d{2}(?=\s|$)/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return `${stripped} on:${onDate}`;
}

/**
 * Relevance-ranked search of public channels through Slack's `assistant.search.context`.
 * A bot token can call it only with the action token of the message that started the turn.
 */
export async function searchSlack(
  request: SlackRequest,
  input: SlackSearchInput,
): Promise<SlackSearchOutcome> {
  const query = slackSearchQuery(input.query, input.onDate);
  try {
    const response = await call(request, "assistant.search.context", {
      query,
      action_token: input.actionToken,
      // The public boundary lives here, so a broader app scope never widens what the tool reads.
      channel_types: "public_channel",
      limit: input.limit,
      cursor: input.cursor,
    });
    const results = isRecord(response.results) ? response.results : {};
    const matches = records(results.messages).map((message): SlackSearchMatch => ({
      channelId: str(message.channel_id),
      channelName: str(message.channel_name),
      ts: str(message.message_ts),
      authorUserId: str(message.author_user_id),
      authorName: str(message.author_name),
      isBot: typeof message.is_author_bot === "boolean" ? message.is_author_bot : undefined,
      text: str(message.content) ?? "",
      permalink: str(message.permalink),
      replyCount: num(message.reply_count),
    }));
    return { query, matches, nextCursor: nextCursor(response) };
  } catch (error) {
    if (slackErrorCode(error) === "invalid_action_token") return { query, tokenExpired: true };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Timestamps

function permalinkTs(value: string): string | undefined {
  const match = /\/p(\d{10})(\d{6})(?:[?#]|$)/i.exec(value);
  return match ? `${match[1]}.${match[2]}` : undefined;
}

function permalinkThreadTs(value: string): string | undefined {
  const match = /[?&]thread_ts=(\d{10}\.\d{6})/i.exec(value);
  return match?.[1] ?? permalinkTs(value);
}

function normalizeMessageTs(value: string, label: string): string {
  const trimmed = value.trim();
  const fromPermalink = permalinkTs(trimmed);
  if (fromPermalink) return fromPermalink;
  if (/^\d{10}\.\d{6,}$/.test(trimmed)) return trimmed;
  const digits = /^(\d{10})(\d{6})$/.exec(trimmed);
  if (digits) return `${digits[1]}.${digits[2]}`;
  throw new Error(`Could not parse a Slack message timestamp from "${value}" for ${label}.`);
}

// Models often hand-compute epochs wrong (wrong year, milliseconds), and Slack silently answers a
// bad window with nothing. Accept unambiguous formats and reject the rest with a clear error.
export function normalizeSlackTimeBoundary(value: string, label: string): string {
  const trimmed = value.trim();
  const fromPermalink = permalinkTs(trimmed);
  if (fromPermalink) return fromPermalink;
  if (/^\d{9,11}(?:\.\d{1,6})?$/.test(trimmed)) return trimmed;
  const digits = /^(\d{10})(\d{6})$/.exec(trimmed);
  if (digits) return `${digits[1]}.${digits[2]}`;
  if (/^\d{12,14}$/.test(trimmed)) return (Number(trimmed) / 1000).toFixed(3);
  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) return (parsed / 1000).toFixed(3);
  throw new Error(
    `Could not parse "${value}" for ${label}. Pass an ISO 8601 datetime (e.g. 2026-07-30T12:00:00Z), a Slack message timestamp (e.g. 1785412800.000000), or Unix epoch seconds.`,
  );
}

export function slackTsToIso(ts: string): string {
  return new Date(Number(ts) * 1000).toISOString();
}

function validateWindow(oldest: string | undefined, latest: string | undefined, nowMs: number) {
  if (oldest && Number(oldest) * 1000 > nowMs + 60_000) {
    throw new Error(
      `The oldest bound resolves to ${slackTsToIso(oldest)}, which is after the current time (${new Date(nowMs).toISOString()}), so the window can never contain messages. Recompute it from the current time.`,
    );
  }
  if (oldest && latest && Number(latest) <= Number(oldest)) {
    throw new Error(
      `The latest bound (${slackTsToIso(latest)}) is not after the oldest bound (${slackTsToIso(oldest)}), so the window can never contain messages. Recompute it.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Channels

/** Parses a channel ID, `<#C…>` mention, or permalink. Returns undefined for a channel name. */
export function parseSlackChannelId(value: string): string | undefined {
  const trimmed = value.trim();
  const mention = /^<#([A-Z0-9]+)(?:\|[^>]*)?>$/i.exec(trimmed);
  if (mention) return mention[1]!.toUpperCase();
  const permalink = /\/archives\/([A-Z0-9]+)/i.exec(trimmed);
  if (permalink) return permalink[1]!.toUpperCase();
  // Uppercase only, so a channel named "general" is never mistaken for an ID.
  return /^[CGD][A-Z0-9]{7,}$/.test(trimmed) ? trimmed : undefined;
}

const CHANNEL_LIST_PAGES = 20;
const CHANNEL_LIST_DEADLINE_MS = 30_000;
const CHANNEL_LIST_TTL_MS = 5 * 60_000;

interface ChannelDirectory {
  readonly idByName: Map<string, string>;
  listedAt: number;
  complete: boolean;
}

const directories = new Map<string, ChannelDirectory>();

async function listPublicChannels(
  request: SlackRequest,
  directory: ChannelDirectory,
): Promise<void> {
  const deadline = Date.now() + CHANNEL_LIST_DEADLINE_MS;
  let cursor: string | undefined;
  directory.complete = false;
  for (let page = 0; page < CHANNEL_LIST_PAGES && Date.now() < deadline; page++) {
    const response = await call(request, "conversations.list", {
      types: "public_channel",
      exclude_archived: true,
      limit: 1000,
      cursor,
    });
    for (const channel of records(response.channels)) {
      const id = str(channel.id);
      const name = str(channel.name);
      if (id && name) directory.idByName.set(name.toLowerCase(), id);
    }
    cursor = nextCursor(response);
    if (!cursor) {
      directory.complete = true;
      break;
    }
  }
  directory.listedAt = Date.now();
}

/** Resolves a public channel name to its ID, listing the workspace's channels at most every few minutes. */
async function findPublicChannelId(
  request: SlackRequest,
  rawName: string,
  workspace: string,
): Promise<{ readonly id?: string; readonly complete: boolean }> {
  const name = rawName.trim().replace(/^#/, "").toLowerCase();
  if (!name) return { complete: true };
  let directory = directories.get(workspace);
  if (!directory) {
    directory = { idByName: new Map(), listedAt: 0, complete: false };
    directories.set(workspace, directory);
  }
  const cached = directory.idByName.get(name);
  if (cached) return { id: cached, complete: true };
  if (Date.now() - directory.listedAt > CHANNEL_LIST_TTL_MS) {
    await listPublicChannels(request, directory);
  }
  return { id: directory.idByName.get(name), complete: directory.complete };
}

export interface SlackChannelSummary {
  readonly id: string;
  readonly name?: string;
  readonly topic?: string;
  readonly purpose?: string;
  readonly memberCount?: number;
}

function channelSummary(channel: Record<string, unknown>, id: string): SlackChannelSummary {
  const topic = isRecord(channel.topic) ? str(channel.topic.value) : undefined;
  const purpose = isRecord(channel.purpose) ? str(channel.purpose.value) : undefined;
  return {
    id,
    name: str(channel.name),
    topic,
    purpose,
    memberCount: num(channel.num_members),
  };
}

// ---------------------------------------------------------------------------
// Conversations

export interface SlackConversationInput {
  /** Channel name, ID, `<#C…>` mention, or permalink. */
  readonly channel: string;
  readonly threadTs?: string;
  readonly limit?: number;
  readonly oldest?: string;
  readonly latest?: string;
  readonly cursor?: string;
}

export interface SlackConversationMessage {
  readonly ts: string;
  readonly threadTs?: string;
  readonly userId?: string;
  readonly botId?: string;
  readonly username?: string;
  readonly subtype?: string;
  readonly text: string;
  readonly replyCount?: number;
  readonly reactions?: readonly { readonly name: string; readonly count: number }[];
}

export type SlackUnavailableReason =
  | "channel_not_found"
  | "private_channel"
  | "not_in_channel"
  | "not_authorized";

export interface SlackUnavailable {
  readonly unavailable: true;
  readonly reason: SlackUnavailableReason;
  readonly message: string;
  readonly channel?: SlackChannelSummary;
}

export interface SlackConversation {
  readonly channel: SlackChannelSummary;
  readonly source: "history" | "replies";
  readonly threadTs?: string;
  readonly permalink?: string;
  readonly messages: readonly SlackConversationMessage[];
  readonly nextCursor?: string;
  readonly oldest?: string;
  readonly latest?: string;
  /** Set when a time window came back empty: the channel's newest message, if it has one. */
  readonly emptyWindow?: { readonly channelLatestTs?: string };
}

export interface SlackConversationOptions {
  /** Keys the channel-name cache. */
  readonly workspace: string;
  /** Checked once the channel is known, before any message is read. */
  readonly authorize: (channelId: string) => Promise<boolean>;
}

function unavailable(
  reason: SlackUnavailableReason,
  message: string,
  channel?: SlackChannelSummary,
): SlackUnavailable {
  return { unavailable: true, reason, message, channel };
}

function notInChannel(channel: SlackChannelSummary): SlackUnavailable {
  const label = channel.name ? `#${channel.name} (${channel.id})` : channel.id;
  return unavailable(
    "not_in_channel",
    `The bot is not a member of ${label}, and Slack requires membership to read a channel's history, even a public one. The bot never joins channels on its own; a channel member can invite it. If this channel came from a search match, answer from the match text and permalink you already have, and do not retry reads in this channel this turn.`,
    channel,
  );
}

const PRIVATE_MESSAGE =
  "This is a private channel or direct message. These tools read public channels only, so its history is unavailable and inviting the bot will not change that. If the content is needed, the user can paste or forward it.";

function normalizeMessage(message: Record<string, unknown>): SlackConversationMessage | undefined {
  const ts = str(message.ts);
  if (!ts) return undefined;
  const reactions = records(message.reactions).flatMap((reaction) => {
    const name = str(reaction.name);
    return name ? [{ name, count: num(reaction.count) ?? 0 }] : [];
  });
  return {
    ts,
    threadTs: str(message.thread_ts),
    userId: str(message.user),
    botId: str(message.bot_id),
    username: str(message.username),
    subtype: str(message.subtype),
    // Forwards, cross-posts, and app messages carry their content in blocks and attachments.
    text: resolveSlackInboundMrkdwn(str(message.text) ?? "", message),
    replyCount: num(message.reply_count) || undefined,
    reactions: reactions.length > 0 ? reactions : undefined,
  };
}

async function permalinkFor(request: SlackRequest, channel: string, ts: string) {
  try {
    const response = await call(request, "chat.getPermalink", { channel, message_ts: ts });
    return str(response.permalink);
  } catch {
    // A missing permalink must not fail the read; the model can still cite channel and thread.
    return undefined;
  }
}

async function latestMessageTs(request: SlackRequest, channel: string) {
  try {
    const response = await call(request, "conversations.history", { channel, limit: 1 });
    return records(response.messages)
      .map((message) => str(message.ts))
      .find(Boolean);
  } catch {
    return undefined;
  }
}

/**
 * Reads a public channel's history or one thread with the bot token. Access boundaries come back
 * as {@link SlackUnavailable} with guidance for the model; malformed input and unexpected Slack
 * failures throw.
 */
export async function readSlackConversation(
  request: SlackRequest,
  input: SlackConversationInput,
  options: SlackConversationOptions,
): Promise<SlackConversation | SlackUnavailable> {
  const threadTs = input.threadTs
    ? normalizeMessageTs(input.threadTs, "threadTs")
    : /\/archives\//i.test(input.channel)
      ? permalinkThreadTs(input.channel)
      : undefined;
  const oldest = input.oldest ? normalizeSlackTimeBoundary(input.oldest, "oldest") : undefined;
  const latest = input.latest ? normalizeSlackTimeBoundary(input.latest, "latest") : undefined;
  validateWindow(oldest, latest, Date.now());

  let channelId = parseSlackChannelId(input.channel);
  if (!channelId) {
    const found = await findPublicChannelId(request, input.channel, options.workspace);
    if (!found.id) {
      return unavailable(
        "channel_not_found",
        found.complete
          ? `No public channel named "${input.channel}" is visible to the bot. Pass a channel ID like C01234ABCDE or a Slack permalink instead.`
          : `The workspace has too many channels to find "${input.channel}" by name. Pass a channel ID like C01234ABCDE or a Slack permalink instead.`,
      );
    }
    channelId = found.id;
  }

  let info: Record<string, unknown>;
  try {
    const response = await call(request, "conversations.info", {
      channel: channelId,
      include_num_members: true,
    });
    info = isRecord(response.channel) ? response.channel : {};
  } catch (error) {
    if (slackErrorCode(error) === "channel_not_found") {
      return unavailable(
        "channel_not_found",
        `Slack has no conversation "${channelId}" visible to the bot. The ID is wrong, the channel is archived, or it is a private channel or direct message the bot is not in. Do not retry with the same reference.`,
      );
    }
    throw error;
  }

  const channel = channelSummary(info, channelId);
  if (info.is_private === true || info.is_im === true || info.is_mpim === true) {
    return unavailable("private_channel", PRIVATE_MESSAGE);
  }
  if (!(await options.authorize(channelId))) {
    return unavailable(
      "not_authorized",
      "This caller may not read that channel. Do not retry or describe its contents; say it isn't available to them.",
    );
  }
  if (info.is_member === false) return notInChannel(channel);

  const page = {
    channel: channelId,
    limit: input.limit ?? 20,
    oldest,
    latest,
    cursor: input.cursor,
  };
  let response: Record<string, unknown>;
  try {
    response = threadTs
      ? await call(request, "conversations.replies", { ...page, ts: threadTs })
      : await call(request, "conversations.history", page);
  } catch (error) {
    if (slackErrorCode(error) === "not_in_channel") return notInChannel(channel);
    if (slackErrorCode(error) === "thread_not_found") {
      throw new Error(`Slack has no thread ${threadTs} in ${channelId}.`);
    }
    throw error;
  }

  const messages = records(response.messages).flatMap((message) => {
    const normalized = normalizeMessage(message);
    return normalized ? [normalized] : [];
  });
  // An empty window is ambiguous: a quiet channel or a miscomputed window. The channel's newest
  // message tells them apart, so the model does not report "no activity" by mistake.
  const emptyWindow =
    !threadTs && messages.length === 0 && (oldest || latest)
      ? { channelLatestTs: await latestMessageTs(request, channelId) }
      : undefined;
  const anchor = threadTs ?? messages[0]?.ts;

  return {
    channel,
    source: threadTs ? "replies" : "history",
    threadTs,
    permalink: anchor ? await permalinkFor(request, channelId, anchor) : undefined,
    messages,
    nextCursor: response.has_more === true ? nextCursor(response) : undefined,
    oldest,
    latest,
    emptyWindow,
  };
}

// ---------------------------------------------------------------------------
// Users

export interface SlackUserProfile {
  readonly id: string;
  readonly name?: string;
  readonly realName?: string;
  readonly displayName?: string;
  readonly title?: string;
  readonly timezone?: string;
  readonly timezoneLabel?: string;
  readonly deleted: boolean;
  readonly isBot: boolean;
}

export function parseSlackUserId(value: string): string {
  const trimmed = value.trim();
  const mention = /^<@([A-Z0-9]+)(?:\|[^>]*)?>$/i.exec(trimmed);
  if (mention) return mention[1]!.toUpperCase();
  if (/^[UW][A-Z0-9]+$/i.test(trimmed)) return trimmed.toUpperCase();
  throw new Error(
    `Could not parse a Slack user ID from "${value}". Pass a user ID like U12345678 or a mention like <@U12345678>.`,
  );
}

/** Reads a user's names, title, and time zone. Contact details are never returned. */
export async function readSlackUser(
  request: SlackRequest,
  userId: string,
): Promise<SlackUserProfile> {
  const response = await call(request, "users.info", { user: parseSlackUserId(userId) });
  const user = isRecord(response.user) ? response.user : {};
  const profile = isRecord(user.profile) ? user.profile : {};
  return {
    id: str(user.id) ?? parseSlackUserId(userId),
    name: str(user.name),
    realName: str(user.real_name) ?? str(profile.real_name),
    displayName: str(profile.display_name),
    title: str(profile.title),
    timezone: str(user.tz),
    timezoneLabel: str(user.tz_label),
    deleted: user.deleted === true,
    isBot: user.is_bot === true,
  };
}
