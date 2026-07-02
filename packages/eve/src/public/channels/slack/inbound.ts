/**
 * Inbound Slack event → harness shaping.
 *
 * The channel calls these helpers on inbound Slack message events before
 * handing them to the runtime:
 *
 * 1. {@link slackMessageFromWebhookPayload} converts the shared Chat SDK
 *    webhook payload into a channel-owned {@link SlackMessage}. The legacy
 *    {@link parseAppMentionEvent} and {@link parseDirectMessageEvent}
 *    helpers keep their raw-envelope behavior for direct unit coverage.
 * 2. The channel renders the actor, message, channel, and thread as one
 *    attributed model message so speaker identity cannot drift away from
 *    the content it describes.
 */

import type {
  SlackAppMentionPayload,
  SlackDirectMessagePayload,
  SlackFile,
} from "#compiled/@chat-adapter/slack/webhook.js";

import { slackMrkdwnToGfm } from "#public/channels/slack/mrkdwn.js";

/**
 * Author metadata for an inbound Slack message. Channel-owned shape;
 * does not depend on the chat SDK's `Author` interface.
 */
export interface SlackAuthor {
  readonly userId: string;
  readonly userName: string | undefined;
  readonly fullName: string | undefined;
  readonly isBot: boolean;
  readonly isMe: boolean;
}

/**
 * Inbound Slack file attachment. The channel reads only `type`, `url`,
 * `name`, `mimeType`, and `size`. The full Slack file object stays
 * available on {@link SlackMessage.raw}.
 */
export interface SlackAttachment {
  readonly id: string;
  readonly type: "image" | "file" | "video" | "audio";
  readonly url: string | undefined;
  readonly name: string | undefined;
  readonly mimeType: string | undefined;
  readonly size: number | undefined;
}

/**
 * Channel-owned representation of one inbound Slack message.
 *
 * Returned for the triggering Slack event. Replaces the chat SDK
 * `Message` type in the public callback surface (e.g.
 * `onAppMention(ctx, message)`).
 */
export interface SlackMessage {
  /** The original Slack text (mrkdwn). */
  readonly text: string;
  /** {@link text} re-rendered as GFM markdown for the agent. */
  readonly markdown: string;
  /** Slack message ts. */
  readonly ts: string;
  /** Thread parent ts (root). Equals {@link ts} for non-thread events. */
  readonly threadTs: string;
  /** Slack channel id. */
  readonly channelId: string;
  /** Slack team id, when the envelope carried one. */
  readonly teamId: string | undefined;
  /** Author of the message. May be `undefined` for system events. */
  readonly author: SlackAuthor | undefined;
  /** File / image attachments on the inbound message. */
  readonly attachments: readonly SlackAttachment[];
  /** Raw inbound event payload from Slack. */
  readonly raw: Record<string, unknown>;
}

/**
 * Slack `app_mention` event envelope (subset of fields the channel
 * actually reads).
 */
interface SlackAppMentionEvent {
  readonly type: "app_mention";
  readonly user?: string;
  readonly text?: string;
  readonly channel?: string;
  readonly ts?: string;
  readonly thread_ts?: string;
  readonly bot_id?: string;
  readonly username?: string;
  readonly files?: readonly Record<string, unknown>[];
  readonly [key: string]: unknown;
}

/**
 * Slack `message` event envelope (subset of fields the channel
 * actually reads). Direct messages arrive as `message` events with
 * `channel_type: "im"`.
 */
interface SlackMessageEvent {
  readonly type: "message";
  readonly channel_type?: string;
  readonly subtype?: string;
  readonly user?: string;
  readonly text?: string;
  readonly channel?: string;
  readonly ts?: string;
  readonly thread_ts?: string;
  readonly bot_id?: string;
  readonly username?: string;
  readonly files?: readonly Record<string, unknown>[];
  readonly [key: string]: unknown;
}

/**
 * Slack webhook envelope for an `event_callback`. The channel cares
 * only about `team_id` (for ergonomic auth derivation) and the inner
 * `event` payload.
 */
export interface SlackEventCallback {
  readonly type: "event_callback";
  readonly team_id?: string;
  readonly event?: { readonly type?: string } & Record<string, unknown>;
  readonly event_id?: string;
  readonly event_time?: number;
  readonly [key: string]: unknown;
}

/**
 * Parses a Slack `app_mention` event into a {@link SlackMessage}.
 *
 * Returns `null` when the envelope is not an `app_mention` event or
 * when required fields (channel id, ts) are missing.
 */
export function parseAppMentionEvent(envelope: SlackEventCallback): SlackMessage | null {
  if (envelope.type !== "event_callback") return null;
  const event = envelope.event;
  if (!event || event.type !== "app_mention") return null;
  return buildSlackMessage(event as SlackAppMentionEvent, envelope.team_id);
}

/**
 * Parses a Slack `message` event with `channel_type: "im"` into a
 * {@link SlackMessage}.
 *
 * Returns `null` when:
 * - the envelope is not an IM `message` event,
 * - required fields (channel id, ts) are missing,
 * - the message carries a system `subtype` (edits, deletes, joins, etc.)
 *   other than `file_share` — file uploads are real user messages and
 *   must reach the handler with their attachments intact, or
 * - the message was posted by a bot (`bot_id` set) — this prevents the
 *   bot's own DM replies from re-triggering the handler.
 */
export function parseDirectMessageEvent(envelope: SlackEventCallback): SlackMessage | null {
  if (envelope.type !== "event_callback") return null;
  const event = envelope.event;
  if (!event || event.type !== "message") return null;

  const message = event as SlackMessageEvent;
  if (message.channel_type !== "im") return null;
  if (
    typeof message.subtype === "string" &&
    message.subtype.length > 0 &&
    message.subtype !== "file_share"
  ) {
    return null;
  }
  if (typeof message.bot_id === "string" && message.bot_id.length > 0) return null;

  return buildSlackMessage(message, envelope.team_id);
}

export function slackMessageFromWebhookPayload(
  payload: SlackAppMentionPayload | SlackDirectMessagePayload,
): SlackMessage | null {
  if (payload.kind === "direct_message") {
    if (
      typeof payload.subtype === "string" &&
      payload.subtype.length > 0 &&
      payload.subtype !== "file_share"
    ) {
      return null;
    }
    if (typeof payload.botId === "string" && payload.botId.length > 0) return null;
  }

  if (!payload.channelId || !payload.ts) return null;
  return {
    text: payload.text,
    markdown: slackMrkdwnToGfm(payload.text),
    ts: payload.ts,
    threadTs: payload.threadTs,
    channelId: payload.channelId,
    teamId: payload.teamId,
    author: parsePayloadAuthor(payload),
    attachments: parsePayloadAttachments(payload.files),
    raw: payload.raw,
  };
}

function buildSlackMessage(
  event: SlackAppMentionEvent | SlackMessageEvent,
  envelopeTeamId: string | undefined,
): SlackMessage | null {
  const channelId = typeof event.channel === "string" ? event.channel : "";
  const ts = typeof event.ts === "string" ? event.ts : "";
  if (!channelId || !ts) return null;

  const text = typeof event.text === "string" ? event.text : "";
  const threadTs = typeof event.thread_ts === "string" ? event.thread_ts : ts;
  const teamId = typeof envelopeTeamId === "string" ? envelopeTeamId : undefined;

  return {
    text,
    markdown: slackMrkdwnToGfm(text),
    ts,
    threadTs,
    channelId,
    teamId,
    author: parseAuthor(event),
    attachments: parseAttachments(event.files),
    raw: event as Record<string, unknown>,
  };
}

function parseAuthor(event: SlackAppMentionEvent | SlackMessageEvent): SlackAuthor | undefined {
  const userId = typeof event.user === "string" ? event.user : "";
  if (!userId) return undefined;
  return {
    userId,
    userName: typeof event.username === "string" ? event.username : undefined,
    fullName: undefined,
    isBot: typeof event.bot_id === "string" && event.bot_id.length > 0,
    isMe: false,
  };
}

function parseAttachments(
  files: readonly Record<string, unknown>[] | undefined,
): SlackAttachment[] {
  if (!Array.isArray(files)) return [];
  return files.map(toAttachment);
}

function toAttachment(file: Record<string, unknown>): SlackAttachment {
  const mimeType = typeof file.mimetype === "string" ? file.mimetype : undefined;
  const url = typeof file.url_private === "string" ? file.url_private : undefined;
  return {
    id: typeof file.id === "string" ? file.id : "",
    type: inferAttachmentType(mimeType),
    url,
    name: typeof file.name === "string" ? file.name : undefined,
    mimeType,
    size: typeof file.size === "number" ? file.size : undefined,
  };
}

function toPayloadAttachment(file: SlackFile): SlackAttachment {
  return {
    id: file.id,
    type: file.type,
    url: file.url,
    name: file.name,
    mimeType: file.mimeType,
    size: file.size,
  };
}

function inferAttachmentType(mimeType: string | undefined): "image" | "file" | "video" | "audio" {
  if (mimeType === undefined) return "file";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "file";
}

function parsePayloadAuthor(
  payload: SlackAppMentionPayload | SlackDirectMessagePayload,
): SlackAuthor | undefined {
  if (!payload.userId) return undefined;
  const raw = payload.raw;
  return {
    userId: payload.userId,
    userName: typeof raw.username === "string" ? raw.username : undefined,
    fullName: undefined,
    isBot: typeof raw.bot_id === "string" && raw.bot_id.length > 0,
    isMe: false,
  };
}

function parsePayloadAttachments(files: readonly SlackFile[] | undefined): SlackAttachment[] {
  if (!Array.isArray(files)) return [];
  return files.map(toPayloadAttachment);
}

/**
 * Verified inbound identity used to attribute a model-visible Slack message.
 *
 * Channel-owned shape so the helper does not depend on the inbound
 * `SlackMessage` and is therefore trivially testable in isolation.
 */
export interface SlackInboundContext {
  readonly userId: string;
  readonly userName?: string;
  readonly fullName?: string;
  readonly channelId: string;
  readonly threadTs: string;
  readonly teamId?: string;
}
