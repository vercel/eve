import type {
  SlackAppMentionPayload,
  SlackDirectMessagePayload,
  SlackFile,
} from "#compiled/@chat-adapter/slack/webhook.js";

import { slackMrkdwnToGfm } from "#public/channels/slack/mrkdwn.js";
import { resolveSlackInboundMrkdwn } from "#public/channels/slack/inbound-content.js";
import { isObject } from "#shared/guards.js";

/**
 * Author metadata for an inbound Slack message. Channel-owned shape;
 * does not depend on the chat SDK's `Author` interface.
 */
export interface SlackAuthor {
  readonly userId: string;
  readonly userName: string | undefined;
  /** Slack real name; set by `messageContext.users`. */
  readonly fullName: string | undefined;
  /** Slack display name; set by `messageContext.users`. */
  readonly displayName?: string;
  /** Slack email; set by `messageContext.users` with `email: true`. */
  readonly email?: string;
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
  /**
   * The message body (mrkdwn). Usually the top-level Slack `text`; when
   * that is empty or a short fallback, derived from Block Kit blocks and
   * legacy attachments on the raw event.
   */
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
  /**
   * Workspace whose app installation received the message, when Slack reported
   * one. eve pairs it with the author's user id to identify the author.
   */
  readonly installationTeamId?: string;
  /** Author of the message. May be `undefined` for system events. */
  readonly author: SlackAuthor | undefined;
  /** File / image attachments on the inbound message. */
  readonly attachments: readonly SlackAttachment[];
  /**
   * Slack's `action_token` for this message, when Slack sent one. The Real-time
   * Search API (`assistant.search.context`) needs it to search for the
   * message's author with a bot token. `defaultSlackAuth` copies it to
   * the `action_token` auth attribute, where tools read it.
   */
  readonly actionToken?: string;
  /** Raw inbound event payload from Slack. */
  readonly raw: Record<string, unknown>;
}

/**
 * Open-ended Slack Events API payload handed to `slackChannel({ onEvent })`.
 * `type` is the Slack event discriminator; all event-specific fields pass
 * through unchanged from the signed webhook body.
 */
export interface SlackEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

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
interface SlackEventCallback {
  readonly type: "event_callback";
  readonly team_id?: string;
  readonly authorizations?: readonly {
    readonly is_bot?: boolean;
    readonly team_id?: string;
    readonly user_id?: string;
  }[];
  readonly event?: { readonly type?: string } & Record<string, unknown>;
  readonly event_id?: string;
  readonly event_time?: number;
  readonly [key: string]: unknown;
}

/**
 * Validated Slack Events API callback envelope handed to `onEvent` through
 * {@link SlackInboundEventContext}. Unlike the permissive parser input type,
 * this shape always carries an event with a non-empty `type` discriminator.
 */
export interface SlackEventEnvelope extends SlackEventCallback {
  readonly event: SlackEvent;
}

export function parseSlackEventEnvelope(body: string): SlackEventEnvelope | null {
  const envelope = JSON.parse(body) as unknown;
  if (!isObject(envelope) || envelope.type !== "event_callback") return null;

  const event = envelope.event;
  if (!isObject(event) || typeof event.type !== "string" || event.type.length === 0) return null;

  return envelope as SlackEventEnvelope;
}

export function parseAppMentionEvent(envelope: SlackEventCallback): SlackMessage | null {
  if (envelope.type !== "event_callback") return null;
  const event = envelope.event;
  if (!event || event.type !== "app_mention") return null;
  return buildSlackMessage(event as SlackAppMentionEvent, envelope);
}

export function slackEventBotUserId(envelope: SlackEventCallback): string | undefined {
  const authorization = envelope.authorizations?.find(
    (entry) => entry.is_bot === true && typeof entry.user_id === "string",
  );
  return authorization?.user_id;
}

export function slackEventReceivingBotUserId(envelope: SlackEventCallback): string | undefined {
  const botUserId = slackEventBotUserId(envelope);
  if (botUserId !== undefined) return botUserId;

  const event = envelope.event;
  const text = typeof event?.text === "string" ? event.text : undefined;
  if (event?.type !== "app_mention" || text === undefined) return undefined;
  return envelope.authorizations?.find(
    (entry) =>
      entry.is_bot === undefined &&
      typeof entry.user_id === "string" &&
      text.includes(`<@${entry.user_id}>`),
  )?.user_id;
}

export function slackEventInstallationTeamId(envelope: SlackEventCallback): string | undefined {
  const authorizations = envelope.authorizations ?? [];
  const botAuthorization = authorizations.find(
    (entry) => entry.is_bot === true && typeof entry.team_id === "string",
  );
  if (botAuthorization?.team_id !== undefined) return botAuthorization.team_id;
  return authorizations.find((entry) => typeof entry.team_id === "string")?.team_id;
}

export function parseMessageEvent(envelope: SlackEventCallback): SlackMessage | null {
  if (envelope.type !== "event_callback") return null;
  const event = envelope.event;
  if (!event || event.type !== "message") return null;
  const message = event as SlackMessageEvent;
  if (!isPostedMessageSubtype(message.subtype)) return null;
  return buildSlackMessage(message, envelope);
}

/**
 * A person's edit to one of their Slack messages, handed to
 * `slackChannel({ onMessageEdited })`.
 */
export interface SlackMessageEdit {
  /** The message as edited: the edited `text`, with the original message's `ts` and thread. */
  readonly message: SlackMessage;
  /** The message's text before the edit (mrkdwn), or `undefined` when Slack didn't include it. */
  readonly previousText: string | undefined;
  /** Slack ts of the edit. */
  readonly editedTs: string;
}

export function parseMessageEditEvent(envelope: SlackEventCallback): SlackMessageEdit | null {
  if (envelope.type !== "event_callback") return null;
  const event = envelope.event;
  if (event?.type !== "message" || event.subtype !== "message_changed") return null;
  const edited = event.message;
  if (!isObject(edited) || !isObject(edited.edited)) return null;
  if (typeof edited.bot_id === "string" && edited.bot_id.length > 0) return null;

  const message = buildSlackMessage(
    {
      ...edited,
      type: "message",
      channel: event.channel,
      channel_type: event.channel_type,
    } as SlackMessageEvent,
    envelope,
  );
  if (message === null || message.author === undefined) return null;

  const previous = isObject(event.previous_message) ? event.previous_message : undefined;
  if (previous !== undefined) {
    const previousEdit = isObject(previous.edited) ? previous.edited : undefined;
    if (previousEdit !== undefined && previousEdit.ts === edited.edited.ts) return null;
    if (previous.text === edited.text) return null;
  }
  const previousText =
    previous === undefined
      ? undefined
      : resolveSlackInboundMrkdwn(typeof previous.text === "string" ? previous.text : "", previous);

  const editedTs =
    typeof edited.edited.ts === "string"
      ? edited.edited.ts
      : typeof event.ts === "string"
        ? event.ts
        : message.ts;
  return { message, previousText, editedTs };
}

const POSTED_MESSAGE_SUBTYPES: ReadonlySet<string> = new Set([
  "bot_message",
  "file_share",
  "me_message",
  "thread_broadcast",
]);

function isPostedMessageSubtype(subtype: string | undefined): boolean {
  return subtype === undefined || subtype === "" || POSTED_MESSAGE_SUBTYPES.has(subtype);
}

export function parseDirectMessageEvent(envelope: SlackEventCallback): SlackMessage | null {
  if (envelope.type !== "event_callback") return null;
  const event = envelope.event;
  if (!event || event.type !== "message") return null;

  const message = event as SlackMessageEvent;
  if (message.channel_type !== "im") return null;
  if (!isHumanMessage(message)) return null;

  return buildSlackMessage(message, envelope);
}

function isHumanMessage(message: SlackMessageEvent): boolean {
  if (!isPostedMessageSubtype(message.subtype)) return false;
  return !(typeof message.bot_id === "string" && message.bot_id.length > 0);
}

export function slackMessageFromWebhookPayload(
  payload: SlackAppMentionPayload | SlackDirectMessagePayload,
  installationTeamId?: string,
): SlackMessage | null {
  if (payload.kind === "direct_message") {
    if (!isPostedMessageSubtype(payload.subtype)) return null;
    if (typeof payload.botId === "string" && payload.botId.length > 0) return null;
  }

  if (!payload.channelId || !payload.ts) return null;
  const text = resolveSlackInboundMrkdwn(payload.text, payload.raw);
  return {
    text,
    markdown: slackMrkdwnToGfm(text),
    ts: payload.ts,
    threadTs: payload.threadTs,
    channelId: payload.channelId,
    teamId: payload.teamId,
    installationTeamId,
    author: parsePayloadAuthor(payload),
    attachments: parsePayloadAttachments(payload.files),
    ...withActionToken(payload.raw),
    raw: payload.raw,
  };
}

function buildSlackMessage(
  event: SlackAppMentionEvent | SlackMessageEvent,
  envelope: SlackEventCallback,
): SlackMessage | null {
  const channelId = typeof event.channel === "string" ? event.channel : "";
  const ts = typeof event.ts === "string" ? event.ts : "";
  if (!channelId || !ts) return null;

  const topLevelText = typeof event.text === "string" ? event.text : "";
  const text = resolveSlackInboundMrkdwn(topLevelText, event as Record<string, unknown>);
  const threadTs = typeof event.thread_ts === "string" ? event.thread_ts : ts;
  const teamId = typeof envelope.team_id === "string" ? envelope.team_id : undefined;
  const installationTeamId = slackEventInstallationTeamId(envelope);

  return {
    text,
    markdown: slackMrkdwnToGfm(text),
    ts,
    threadTs,
    channelId,
    teamId,
    installationTeamId,
    author: parseAuthor(event),
    attachments: parseAttachments(event.files),
    ...withActionToken(event),
    raw: event as Record<string, unknown>,
  };
}

function withActionToken(raw: Record<string, unknown>): { actionToken?: string } {
  const nested = isObject(raw.assistant_thread) ? raw.assistant_thread.action_token : undefined;
  const token = [raw.action_token, nested].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  return token === undefined ? {} : { actionToken: token.trim() };
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

export function parseAttachments(
  files: readonly Record<string, unknown>[] | undefined,
): SlackAttachment[] {
  if (!Array.isArray(files)) return [];
  return files.filter((file) => !isRemoteFile(file)).map(toAttachment);
}

function isRemoteFile(file: Readonly<Record<string, unknown>>): boolean {
  return file.mode === "external" || file.is_external === true;
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
  return files.filter((file) => !isRemoteFile(file.raw)).map(toPayloadAttachment);
}

/**
 * Verified inbound identity used to attribute a model-visible Slack message.
 *
 * Channel-owned shape so the helper does not depend on the inbound
 * `SlackMessage` and is therefore trivially testable in isolation.
 */
export interface SlackInboundContext {
  readonly botUserId?: string;
  readonly userId: string;
  readonly userName?: string;
  readonly fullName?: string;
  readonly displayName?: string;
  readonly email?: string;
  readonly channelId: string;
  readonly isMentioned?: boolean;
  readonly threadTs: string;
  readonly teamId?: string;
}
