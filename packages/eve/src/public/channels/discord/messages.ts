/**
 * Ordinary Discord messages, which Discord delivers only over its Gateway
 * WebSocket. A relay such as `runDiscordGatewayRelay` from
 * `eve/channels/discord/gateway` holds that connection and forwards each
 * dispatch, unchanged, to the route this module mounts.
 */

import type { SessionAuthContext } from "#channel/types.js";
import { createLogger, logError } from "#internal/logging.js";
import { type AuthFn, localDev, routeAuth, vercelOidc } from "#public/channels/auth.js";
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

/** Conversation id of a session that spans a whole channel: a DM or a thread. */
const WHOLE_CHANNEL_CONVERSATION = "channel";

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
  /**
   * Whether the message is meant for the bot: a direct message, a mention, a
   * reply to one of the bot's messages, or a message in a thread where the bot
   * already has a conversation.
   */
  readonly addressed: boolean;
  /** Discord's raw message object. */
  readonly raw: Record<string, unknown>;
}

/**
 * Result of the Gateway message hook. Return `null` to ignore the message.
 * - `auth`: session auth context for the dispatched turn, or `null` for anonymous.
 * - `context`: model-visible context lines appended after the Discord context block.
 * - `title`: workflow run title override that does not change model input.
 */
export type DiscordMessageResult = {
  readonly auth: SessionAuthContext | null;
  readonly context?: readonly string[];
  readonly title?: string;
} | null;

/** Sync or async {@link DiscordMessageResult}. */
export type DiscordMessageResultOrPromise = DiscordMessageResult | Promise<DiscordMessageResult>;

/** Configuration for `discordChannel({ gateway })`. */
export interface DiscordGatewayConfig {
  /** Override the route that accepts forwarded dispatches (`/eve/v1/discord/gateway`). */
  readonly route?: string;
  /**
   * Authenticates the relay. Defaults to `localDev()` plus Vercel OIDC tokens
   * minted for this project to a non-user caller, which is what
   * `runDiscordGatewayRelay` sends from a Vercel Daemon.
   */
  readonly auth?: AuthFn<Request> | readonly AuthFn<Request>[];
  /**
   * Decides whether a message dispatches and under what `auth`. Called for
   * every conversational message from a person; bot authors never reach it.
   * Defaults to dispatching addressed messages with
   * `defaultDiscordMessageAuth`.
   */
  onMessage?(ctx: DiscordContext, message: DiscordGatewayMessage): DiscordMessageResultOrPromise;
}

/** Mounts the route that turns forwarded `MESSAGE_CREATE` dispatches into turns. */
export function createDiscordGatewayRoute(input: {
  readonly config: DiscordChannelConfig;
  readonly gateway: DiscordGatewayConfig;
  readonly buildContext: (state: DiscordChannelState) => DiscordContext;
}): HttpRouteDefinition<DiscordChannelState> {
  const { config, gateway } = input;
  const auth = gateway.auth ?? [localDev(), sameProjectService()];
  const onMessage = gateway.onMessage ?? defaultOnMessage;

  return POST<DiscordChannelState>(
    gateway.route ?? DEFAULT_GATEWAY_ROUTE,
    async (req, { from, resolveSession }) => {
      const caller = await routeAuth(req, auth);
      if (caller instanceof Response) return caller;

      let dispatch: unknown;
      try {
        dispatch = JSON.parse(await req.text());
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
        audience: discordAudience(isDirectMessage ? 1 : undefined),
        channelId: message.channelId,
        conversationId: null,
        guildId: message.guildId ?? null,
        // Replies post as channel messages; only prompts with components alias the session.
        hasMessageAnchor: true,
        initialResponseSent: true,
        interactionToken: null,
      };

      let result: DiscordMessageResult;
      try {
        result = await onMessage(input.buildContext(state), message);
      } catch (error) {
        logError(log, "Discord message handler failed", error, { messageId: message.id });
        return Response.json({ error: "The message handler failed." }, { status: 500 });
      }
      if (result === null) return ignored("not_accepted");

      if (isDirectMessage || channelSession !== undefined) {
        state.conversationId = WHOLE_CHANNEL_CONVERSATION;
      } else {
        const channelType = await lookUpChannelType(config, message.channelId);
        state.audience = discordAudience(channelType);
        state.conversationId =
          channelType !== undefined && THREAD_CHANNEL_TYPES.has(channelType)
            ? WHOLE_CHANNEL_CONVERSATION
            : `user:${message.author.id}`;
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
        discordContinuationToken(message.channelId, state.conversationId),
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

/** Same-project Vercel OIDC, minus user tokens: the relay is a service, not a person. */
function sameProjectService(): AuthFn<Request> {
  const oidc = vercelOidc();
  return async (request) => {
    const auth = await oidc(request);
    return auth && auth.principalType !== "user" ? auth : null;
  };
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
  };
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
