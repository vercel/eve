/**
 * Ordinary Discord messages, which Discord delivers only over its Gateway
 * WebSocket. A relay such as `experimental_runDiscordGatewayRelay` from
 * `eve/channels/discord/gateway` holds that connection and forwards each
 * dispatch, unchanged, to the route this module mounts.
 */

import type { SessionAuthContext } from "#channel/types.js";
import { EveAttachmentError } from "#internal/attachments/errors.js";
import { readLimitedBytes } from "#internal/attachments/limited-read.js";
import { createLogger, logError } from "#internal/logging.js";
import { type AuthFn, localDev, routeAuth } from "#public/channels/auth.js";
import { sameEnvironmentVercelOidc } from "#public/channels/same-environment-oidc.js";
import {
  callDiscordApi,
  discordContinuationToken,
  resolveDiscordApplicationId,
  resolveDiscordBotToken,
} from "#public/channels/discord/api.js";
import { discordCommandContent } from "#public/channels/discord/attachments.js";
import { discordAudience } from "#public/channels/discord/audience.js";
import { defaultOnMessage } from "#public/channels/discord/defaults.js";
import type {
  DiscordChannelConfig,
  DiscordChannelState,
  DiscordContext,
} from "#public/channels/discord/discordChannel.js";
import {
  formatDiscordContextBlock,
  parseDiscordAttachment,
  parseDiscordUser,
  type DiscordAttachment,
  type DiscordUser,
} from "#public/channels/discord/inbound.js";
import { POST, type HttpRouteDefinition } from "#channel/routes.js";
import { isNonEmptyString, isObject } from "#shared/guards.js";

const log = createLogger("discord.gateway");

/** Default path of the route that accepts forwarded Gateway dispatches. */
const DEFAULT_GATEWAY_ROUTE = "/eve/v1/discord/gateway";

/** Conversation key of a session that spans a whole channel: a DM or a thread. */
const WHOLE_CHANNEL_CONVERSATION = "channel";

// A MESSAGE_CREATE dispatch is a few kilobytes; the cap only bounds a misbehaving relay.
const MAX_DISPATCH_BYTES = 1024 * 1024;

// DEFAULT and REPLY. Other types are system notices such as joins and pins.
const CONVERSATIONAL_MESSAGE_TYPES = new Set([0, 19]);
const THREAD_CHANNEL_TYPES = new Set([10, 11, 12]);

/** An ordinary Discord message forwarded from the Gateway. */
export interface DiscordGatewayMessage {
  readonly id: string;
  readonly channelId: string;
  /** Absent for direct messages. */
  readonly guildId?: string;
  /**
   * Message text with the bot's own mention removed. Discord sends an empty
   * string for messages that neither mention the bot nor arrive as a DM unless
   * the bot has the Message Content intent.
   */
  readonly content: string;
  readonly author: DiscordUser;
  readonly attachments: readonly DiscordAttachment[];
  /** ID of the message this one replies to, if any. */
  readonly referencedMessageId?: string;
  /**
   * Whether the message is meant for the bot: a direct message, a mention, a
   * reply to one of the bot's messages, or a message in a thread where the bot
   * already has a conversation.
   */
  readonly addressed: boolean;
  /** Discord's raw message object. */
  readonly raw: Record<string, unknown>;
}

/** Minutes of inactivity before Discord archives a thread; the values Discord accepts. */
export type DiscordThreadAutoArchiveMinutes = 60 | 1440 | 4320 | 10080;

/** Options for starting a thread from a message; see {@link DiscordMessageResult.startThread}. */
export interface DiscordStartThreadOptions {
  /** Thread name. Defaults to the message's first line, then its first attachment's filename. */
  readonly name?: string;
  /** Defaults to the channel's own setting. */
  readonly autoArchiveMinutes?: DiscordThreadAutoArchiveMinutes;
}

/**
 * Result of the Gateway message hook. Return `null` to ignore the message.
 * - `auth`: session auth context for the dispatched turn, or `null` for anonymous.
 * - `context`: model-visible context lines appended after the Discord context block.
 * - `title`: workflow run title override that does not change model input.
 * - `conversation`: which session in the channel the message joins; see
 *   {@link DiscordMessageResult.conversation}.
 * - `startThread`: answer in a new thread off the message; see
 *   {@link DiscordMessageResult.startThread}.
 */
export type DiscordMessageResult = {
  readonly auth: SessionAuthContext | null;
  readonly context?: readonly string[];
  readonly title?: string;
  /**
   * Key of the session the message joins within its Discord channel. Messages
   * with the same key share a session. A message ID is the key of the
   * session that owns that message: the one it started, or the one whose bot
   * reply it is. `"channel"` is one session for the whole channel. Any other
   * string is your own grouping, such as `` `user:${message.author.id}` ``.
   *
   * Defaults to `"channel"` in DMs and threads, which includes the thread a
   * text-channel mention starts; elsewhere, to the replied-to message's session
   * when one owns it, or else a new session keyed by this message.
   */
  readonly conversation?: string;
  /**
   * Starts a thread from the message and moves the conversation into it, as
   * one session for the thread. Applies only when the message would start a
   * new session in a text channel: DMs, messages already in a thread, and
   * replies that continue a session are left as they are. eve adds the author
   * to the thread. When Discord refuses, for example because the bot lacks the
   * Create Public Threads permission, the message is handled as if
   * `startThread` were `false`. Defaults to `gateway.startThread`.
   */
  readonly startThread?: boolean | DiscordStartThreadOptions;
} | null;

/** Sync or async {@link DiscordMessageResult}. */
export type DiscordMessageResultOrPromise = DiscordMessageResult | Promise<DiscordMessageResult>;

/** Configuration for `discordChannel({ gateway })`. */
export interface DiscordGatewayConfig {
  /** Override the route that accepts forwarded dispatches (`/eve/v1/discord/gateway`). */
  readonly route?: string;
  /**
   * Authenticates the relay. The body names the message author, so whoever
   * passes can act as any Discord user. Defaults to `localDev()` plus Vercel
   * OIDC tokens from this project's own runtime in the same environment,
   * which is what `experimental_runDiscordGatewayRelay` sends from a Vercel Daemon.
   */
  readonly auth?: AuthFn<Request> | readonly AuthFn<Request>[];
  /**
   * Decides whether a message dispatches, under what `auth`, and which
   * session it joins. Called for every conversational message from a person;
   * bot authors never reach it. Defaults to dispatching addressed messages
   * with `defaultDiscordMessageAuth` and the default `conversation`.
   */
  onMessage?(ctx: DiscordContext, message: DiscordGatewayMessage): DiscordMessageResultOrPromise;
  /**
   * Default for each accepted message's `startThread`. Defaults to `true`, so
   * the bot answers a mention in a text channel in a new thread; set `false`
   * to answer in the channel, where replies continue the conversation. An
   * `onMessage` result's own `startThread` overrides it.
   */
  readonly startThread?: boolean | DiscordStartThreadOptions;
}

/** Mounts the route that turns forwarded `MESSAGE_CREATE` dispatches into turns. */
export function createDiscordGatewayRoute(input: {
  readonly config: DiscordChannelConfig;
  readonly gateway: DiscordGatewayConfig;
  readonly buildContext: (state: DiscordChannelState) => DiscordContext;
}): HttpRouteDefinition<DiscordChannelState> {
  const { config, gateway } = input;
  const auth = gateway.auth ?? [localDev(), sameEnvironmentVercelOidc()];
  const onMessage = gateway.onMessage ?? defaultOnMessage;

  return POST<DiscordChannelState>(
    gateway.route ?? DEFAULT_GATEWAY_ROUTE,
    async (req, { from, resolveSession }) => {
      const caller = await routeAuth(req, auth);
      if (caller instanceof Response) return caller;

      let body: Buffer;
      try {
        body = await readLimitedBytes(req, MAX_DISPATCH_BYTES, "discord");
      } catch (error) {
        if (!(error instanceof EveAttachmentError)) throw error;
        return Response.json({ error: "Body exceeds 1 MB." }, { status: 413 });
      }
      let dispatch: unknown;
      try {
        dispatch = JSON.parse(body.toString("utf8"));
      } catch {
        return Response.json({ error: "Body is not JSON." }, { status: 400 });
      }
      if (!isObject(dispatch) || dispatch.t !== "MESSAGE_CREATE")
        return ignored("unsupported_event");
      const raw = isObject(dispatch.d) ? dispatch.d : null;
      const parsed = raw === null ? null : parseGatewayMessage(raw);
      if (parsed === null) return ignored("invalid_message");
      if (parsed.author.isBot) return ignored("bot_author");

      const applicationId = await resolveDiscordApplicationId(config.credentials?.applicationId);
      const content = stripMention(parsed.content, applicationId);
      if (!content && parsed.attachments.length === 0) return ignored("empty_message");

      const isDirectMessage = parsed.guildId === undefined;
      const channelSession = isDirectMessage
        ? undefined
        : await resolveSession(
            discordContinuationToken(parsed.channelId, WHOLE_CHANNEL_CONVERSATION),
          );
      const message: DiscordGatewayMessage = {
        ...parsed,
        addressed:
          isDirectMessage ||
          channelSession !== undefined ||
          mentions(parsed.raw, applicationId) ||
          repliesTo(parsed.raw, applicationId),
        content,
      };

      const state: DiscordChannelState = {
        applicationId,
        channelId: message.channelId,
        conversationId: null,
        guildId: message.guildId ?? null,
        // Replies post as channel messages, which alias the session without re-keying it.
        hasMessageAnchor: true,
        initialResponseSent: true,
        interactionToken: null,
      };
      // Bots receive only 1:1 DMs over the Gateway, never group DMs.
      if (isDirectMessage) {
        state.audience = discordAudience(1);
        state.directMessage = true;
      }

      let result: DiscordMessageResult;
      try {
        result = await onMessage(input.buildContext(state), message);
      } catch (error) {
        logError(log, "Discord message handler failed", error, { messageId: message.id });
        return Response.json({ error: "The message handler failed." }, { status: 500 });
      }
      if (result === null) return ignored("not_accepted");

      const explicitConversation = isNonEmptyString(result.conversation)
        ? result.conversation
        : undefined;
      const startThread = result.startThread ?? gateway.startThread ?? true;
      state.conversationId = await routeMessage();

      // Picks the session, and moves the message's replies into a new thread when asked.
      async function routeMessage(): Promise<string> {
        if (isDirectMessage || channelSession !== undefined) {
          return explicitConversation ?? WHOLE_CHANNEL_CONVERSATION;
        }
        if (explicitConversation === undefined) {
          const replyTo = message.referencedMessageId;
          if (
            replyTo !== undefined &&
            (await resolveSession(discordContinuationToken(message.channelId, replyTo))) !==
              undefined
          ) {
            return replyTo;
          }
        } else if (startThread === false) {
          return explicitConversation;
        }
        const channelType = await lookUpChannelType(config, message.channelId);
        if (channelType !== undefined) state.audience = discordAudience(channelType);
        if (channelType !== undefined && THREAD_CHANNEL_TYPES.has(channelType)) {
          return explicitConversation ?? WHOLE_CHANNEL_CONVERSATION;
        }
        if (startThread !== false) {
          const threadId = await startThreadFrom(
            config,
            message,
            startThread === true ? {} : startThread,
          );
          if (threadId !== undefined) {
            state.channelId = threadId;
            state.audience = "unknown";
            return explicitConversation ?? WHOLE_CHANNEL_CONVERSATION;
          }
        }
        return explicitConversation ?? message.id;
      }

      const contextBlock = formatDiscordContextBlock({
        applicationId,
        channelId: message.channelId,
        guildId: message.guildId,
        messageId: message.id,
        userId: message.author.id,
        username: message.author.username,
      });
      const session = await from(
        discordContinuationToken(state.channelId ?? message.channelId, state.conversationId),
      ).send(discordCommandContent(content, message.attachments), {
        auth: result.auth,
        context: [contextBlock, ...(result.context ?? [])],
        state,
        title: result.title,
      });
      return Response.json({ accepted: true, sessionId: session.id }, { status: 202 });
    },
  );
}

function ignored(reason: string): Response {
  return Response.json({ accepted: false, reason });
}

function parseGatewayMessage(
  raw: Record<string, unknown>,
): Omit<DiscordGatewayMessage, "addressed"> | null {
  if (!isNonEmptyString(raw.id) || !isNonEmptyString(raw.channel_id)) return null;
  if (typeof raw.type === "number" && !CONVERSATIONAL_MESSAGE_TYPES.has(raw.type)) return null;
  const author = parseDiscordUser(raw.author);
  if (author === null) return null;
  return {
    attachments: Array.isArray(raw.attachments)
      ? raw.attachments.flatMap((entry) => parseDiscordAttachment(entry) ?? [])
      : [],
    author,
    channelId: raw.channel_id,
    content: typeof raw.content === "string" ? raw.content : "",
    guildId: isNonEmptyString(raw.guild_id) ? raw.guild_id : undefined,
    id: raw.id,
    raw,
    referencedMessageId: referencedMessageId(raw),
  };
}

function referencedMessageId(raw: Record<string, unknown>): string | undefined {
  const reference = isObject(raw.message_reference) ? raw.message_reference : null;
  // Type 1 is a forward, which quotes a message rather than replying to it.
  if (reference === null || (reference.type !== undefined && reference.type !== 0))
    return undefined;
  return isNonEmptyString(reference.message_id) ? reference.message_id : undefined;
}

// A bot user's id is its application's id.
function mentions(raw: Record<string, unknown>, applicationId: string): boolean {
  return (
    Array.isArray(raw.mentions) &&
    raw.mentions.some((user) => isObject(user) && user.id === applicationId)
  );
}

function repliesTo(raw: Record<string, unknown>, applicationId: string): boolean {
  const referenced = isObject(raw.referenced_message) ? raw.referenced_message : null;
  return isObject(referenced?.author) && referenced.author.id === applicationId;
}

function stripMention(content: string, applicationId: string): string {
  return content
    .replaceAll(`<@${applicationId}>`, "")
    .replaceAll(`<@!${applicationId}>`, "")
    .trim();
}

const DISCORD_THREAD_NAME_MAX_LENGTH = 100;

/**
 * Starts a public thread from `message` and adds its author, returning the
 * thread's channel id, or `undefined` when Discord refuses.
 */
async function startThreadFrom(
  config: DiscordChannelConfig,
  message: DiscordGatewayMessage,
  options: DiscordStartThreadOptions,
): Promise<string | undefined> {
  const name =
    options.name?.trim() ||
    message.content.split("\n", 1)[0]?.trim() ||
    message.attachments[0]?.filename ||
    "Conversation";
  const body: Record<string, string | number> = {
    name: name.slice(0, DISCORD_THREAD_NAME_MAX_LENGTH),
  };
  if (options.autoArchiveMinutes !== undefined) {
    body.auto_archive_duration = options.autoArchiveMinutes;
  }
  try {
    const botToken = await resolveDiscordBotToken(config.credentials?.botToken);
    const api = { apiBaseUrl: config.api?.apiBaseUrl, botToken, fetch: config.api?.fetch };
    const created = await callDiscordApi({
      ...api,
      body,
      path: `/channels/${encodeURIComponent(message.channelId)}/messages/${encodeURIComponent(message.id)}/threads`,
    });
    const threadId = isObject(created.body) ? created.body.id : undefined;
    if (!created.ok || !isNonEmptyString(threadId)) {
      log.warn("Discord thread creation failed; answering in the channel", {
        channelId: message.channelId,
        status: created.status,
      });
      return undefined;
    }
    // Starting a thread adds only the bot, so its replies would not reach the author.
    const added = await callDiscordApi({
      ...api,
      method: "PUT",
      path: `/channels/${encodeURIComponent(threadId)}/thread-members/${encodeURIComponent(message.author.id)}`,
    });
    if (!added.ok) {
      log.warn("Adding the author to a Discord thread failed", { status: added.status, threadId });
    }
    return threadId;
  } catch (error) {
    log.warn("Discord thread creation failed; answering in the channel", {
      channelId: message.channelId,
      error,
    });
    return undefined;
  }
}

/** Gateway messages omit the channel type, which tells a thread from a channel. */
async function lookUpChannelType(
  config: DiscordChannelConfig,
  channelId: string,
): Promise<number | undefined> {
  try {
    const response = await callDiscordApi({
      apiBaseUrl: config.api?.apiBaseUrl,
      botToken: await resolveDiscordBotToken(config.credentials?.botToken),
      fetch: config.api?.fetch,
      method: "GET",
      path: `/channels/${encodeURIComponent(channelId)}`,
    });
    if (response.ok && isObject(response.body) && typeof response.body.type === "number") {
      return response.body.type;
    }
    log.warn("Discord channel lookup failed; treating the channel as a non-thread", {
      channelId,
      status: response.status,
    });
  } catch (error) {
    log.warn("Discord channel lookup failed; treating the channel as a non-thread", {
      channelId,
      error,
    });
  }
  return undefined;
}
