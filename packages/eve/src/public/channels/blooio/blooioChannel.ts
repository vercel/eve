import type { UserContent } from "ai";

import type { SessionAuthContext } from "#channel/types.js";
import type { SessionContext } from "#public/definitions/callback-context.js";
import type { ChannelSessionOps } from "#public/definitions/defineChannel.js";

import { createLogger } from "#internal/logging.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import {
  blooioContinuationToken,
  callBlooioApi,
  checkBlooioCapabilities,
  listBlooioMessages,
  markBlooioChatRead,
  reactBlooioMessage,
  sendBlooioMessage,
  startBlooioTyping,
  stopBlooioTyping,
  type BlooioApiResponse,
  type BlooioCredentials,
  type BlooioFetch,
  type BlooioListMessagesInput,
  type BlooioMessageEffect,
  type BlooioSendMessageInput,
  type BlooioWebhookSecret,
} from "#public/channels/blooio/api.js";
import { defaultEvents, defaultOnMessage } from "#public/channels/blooio/defaults.js";
import {
  formatBlooioContextBlock,
  parseBlooioInboundMessage,
  resolveAttachmentMediaType,
  type BlooioInboundMessage,
} from "#public/channels/blooio/inbound.js";
import { verifyBlooioRequest } from "#public/channels/blooio/verify.js";
import {
  defineChannel,
  POST,
  type Channel,
  type SendFn,
} from "#public/definitions/defineChannel.js";

const log = createLogger("blooio.channel");

type EventData<T extends HandleMessageStreamEvent["type"]> =
  Extract<HandleMessageStreamEvent, { type: T }> extends { data: infer D } ? D : undefined;

/** Pre-dispatch Blooio context passed to the inbound message hook. */
export interface BlooioContext {
  readonly blooio: BlooioHandle;
}

/** Channel-owned Blooio context returned by `context()`. */
export interface BlooioChannelContext extends BlooioContext {
  state: BlooioChannelState;
}

/** Event-handler Blooio context, including session operations. */
export interface BlooioEventContext extends BlooioChannelContext, ChannelSessionOps {}

/** JSON-serializable durable state for one Blooio conversation. */
export interface BlooioChannelState {
  /** Reply target: phone (E.164), email, or group ID (`grp_...`). */
  chatId: string | null;
  /** Blooio device/number that received the conversation (our line). */
  internalId: string | null;
  /** Sender of the most recent inbound message. */
  sender: string | null;
  /** Whether the conversation is a group chat. */
  isGroup: boolean;
  /** Most recent inbound Blooio message ID. */
  lastMessageId: string | null;
}

/** Per-session instrumentation snapshot for Blooio runtime telemetry. Reports the active line, reply target, group flag, and the most recent inbound message ID. */
export interface BlooioInstrumentationMetadata extends Record<string, unknown> {
  readonly chatId: string | null;
  readonly internalId: string | null;
  readonly isGroup: boolean;
  readonly lastMessageId: string | null;
}

/** Sender allow list for inbound Blooio webhook triggers. `"*"` allows every verified sender. */
export type BlooioAllowFrom =
  | string
  | readonly string[]
  | (() => string | readonly string[] | Promise<string | readonly string[]>);

/** Result of an inbound Blooio message hook. Return `null` (or `undefined`) to drop the webhook without dispatching; otherwise supply the session `auth` context. */
export type BlooioInboundResult = {
  auth: SessionAuthContext | null;
} | null;

/** Sync or async {@link BlooioInboundResult}. */
export type BlooioInboundResultOrPromise = BlooioInboundResult | Promise<BlooioInboundResult>;

/** Target accepted by `receive(blooio, { target })` for proactive conversations. */
export interface BlooioReceiveTarget {
  /** Conversation target: phone (E.164), email, group ID (`grp_...`), or comma-separated recipients. */
  readonly chatId: string;
  /** Blooio number to send from, included in the continuation token. */
  readonly fromNumber?: string;
}

type BlooioEventHandler<T extends HandleMessageStreamEvent["type"]> = (
  data: EventData<T>,
  channel: BlooioEventContext,
  ctx: SessionContext,
) => void | Promise<void>;

type BlooioSessionFailedHandler = (
  data: EventData<"session.failed">,
  channel: BlooioEventContext,
) => void | Promise<void>;

/** Event handlers supported by `blooioChannel({ events })`. */
export interface BlooioChannelEvents {
  readonly "turn.started"?: BlooioEventHandler<"turn.started">;
  readonly "actions.requested"?: BlooioEventHandler<"actions.requested">;
  readonly "action.result"?: BlooioEventHandler<"action.result">;
  readonly "message.completed"?: BlooioEventHandler<"message.completed">;
  readonly "message.appended"?: BlooioEventHandler<"message.appended">;
  readonly "input.requested"?: BlooioEventHandler<"input.requested">;
  readonly "turn.failed"?: BlooioEventHandler<"turn.failed">;
  readonly "turn.completed"?: BlooioEventHandler<"turn.completed">;
  readonly "session.failed"?: BlooioSessionFailedHandler;
  readonly "session.completed"?: BlooioEventHandler<"session.completed">;
  readonly "session.waiting"?: BlooioEventHandler<"session.waiting">;
  readonly "authorization.required"?: BlooioEventHandler<"authorization.required">;
  readonly "authorization.completed"?: BlooioEventHandler<"authorization.completed">;
}

/** Per-call overrides for {@link BlooioHandle.sendMessage}. */
export interface BlooioSendMessageOptions {
  /** Recipient. Defaults to the conversation's `chatId`. */
  readonly chatId?: string;
  /** Sender number. Defaults to `fromNumber`, then the inbound `internalId`. */
  readonly fromNumber?: string;
  readonly attachments?: BlooioSendMessageInput["attachments"];
  readonly effect?: BlooioMessageEffect;
  readonly replyToMessageId?: string;
  readonly shareContact?: boolean;
  readonly useTypingIndicator?: boolean;
  readonly idempotencyKey?: string;
}

/** Low-level Blooio handle exposed to hooks and event handlers. */
export interface BlooioHandle {
  /** Reply target bound to this conversation. */
  readonly chatId: string;
  /** Blooio number that received this conversation, when known. */
  readonly internalId: string | undefined;
  /** Sender of the most recent inbound message, when known. */
  readonly sender: string | undefined;
  readonly isGroup: boolean;
  /** Sends a text and/or attachment message to this conversation by default. */
  sendMessage(message: string, options?: BlooioSendMessageOptions): Promise<BlooioApiResponse>;
  /** Adds (`+`) or removes (`-`) a tapback/emoji reaction on a message. */
  react(
    messageId: string,
    reaction: string,
    options?: { chatId?: string; direction?: "inbound" | "outbound" },
  ): Promise<BlooioApiResponse>;
  /** Shows the typing indicator (iMessage-only). */
  startTyping(chatId?: string): Promise<BlooioApiResponse>;
  /** Hides the typing indicator. */
  stopTyping(chatId?: string): Promise<BlooioApiResponse>;
  /** Marks the conversation read and sends a read receipt. */
  markRead(chatId?: string): Promise<BlooioApiResponse>;
  /** Checks whether a contact supports iMessage, SMS, and/or FaceTime. */
  checkCapabilities(contact?: string): Promise<BlooioApiResponse>;
  /** Lists messages in the conversation. */
  listMessages(
    options?: Omit<BlooioListMessagesInput, "chatId" | "credentials" | "baseUrl" | "fetch"> & {
      chatId?: string;
    },
  ): Promise<BlooioApiResponse>;
  /** Raw Blooio v2 API escape hatch. `path` is appended to the API base URL. */
  request(
    method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT",
    path: string,
    body?: unknown,
    query?: Readonly<Record<string, string | number | boolean | undefined | null>>,
  ): Promise<BlooioApiResponse>;
}

/** Configuration for {@link blooioChannel}. */
export interface BlooioChannelConfig {
  readonly credentials?: BlooioCredentials;
  /** Route for the Blooio webhook. Defaults to `/eve/v1/blooio`. */
  readonly route?: string;
  /** Override the API base URL. Falls back to `BLOOIO_BASE_URL`, then the public default. */
  readonly baseUrl?: string;
  /** Fetch override for REST calls. */
  readonly fetch?: BlooioFetch;
  /** Maximum allowed age of a webhook signature, in seconds. Defaults to 300. */
  readonly timestampToleranceSec?: number;
  /**
   * Exact senders allowed to reach the inbound hook, or `"*"` to allow every
   * verified sender. Defaults to `"*"`.
   */
  readonly allowFrom?: BlooioAllowFrom;
  /** Default sender number for outbound replies. Falls back to the inbound `internalId`. */
  readonly fromNumber?: string;
  /** Mark conversations read when an inbound message is received. Defaults to `false`. */
  readonly markReadOnReceive?: boolean;
  /** Override the secret used to verify webhook signatures (defaults to `credentials.webhookSecret`). */
  readonly webhookSecret?: BlooioWebhookSecret;

  /** Inbound message hook. Defaults to sender auth and dispatch. */
  onMessage?(ctx: BlooioContext, message: BlooioInboundMessage): BlooioInboundResultOrPromise;

  readonly events?: BlooioChannelEvents;
}

/** Concrete return type of {@link blooioChannel}. */
export interface BlooioChannel
  extends Channel<BlooioChannelState, BlooioReceiveTarget, BlooioInstrumentationMetadata> {}

/**
 * Blooio channel factory for inbound and outbound iMessage, RCS, and SMS via
 * the Blooio v2 API. Verifies `X-Blooio-Signature` webhooks, dispatches
 * `message.received` events into the agent, and replies through the Blooio
 * REST API.
 */
export function blooioChannel(config: BlooioChannelConfig = {}): BlooioChannel {
  const route = config.route ?? "/eve/v1/blooio";
  const allowFrom = config.allowFrom ?? "*";
  const onMessage = config.onMessage ?? defaultOnMessage;
  const mergedEvents: BlooioChannelEvents = { ...defaultEvents, ...config.events };

  return defineChannel<
    BlooioChannelState,
    BlooioChannelContext,
    BlooioReceiveTarget,
    BlooioInstrumentationMetadata
  >({
    kindHint: "blooio",
    state: {
      chatId: null,
      internalId: null,
      isGroup: false,
      lastMessageId: null,
      sender: null,
    },
    metadata(state): BlooioInstrumentationMetadata {
      return {
        chatId: state.chatId,
        internalId: state.internalId,
        isGroup: state.isGroup,
        lastMessageId: state.lastMessageId,
      };
    },

    context(state): BlooioChannelContext {
      return {
        state,
        blooio: buildBlooioHandle({
          chatId: state.chatId ?? "",
          config,
          internalId: state.internalId ?? undefined,
          isGroup: state.isGroup,
          sender: state.sender ?? undefined,
        }),
      };
    },

    routes: [
      POST<BlooioChannelState>(route, async (req, { send, waitUntil }) => {
        const verified = await verifyInbound(req, config);
        if (verified === null) return new Response("unauthorized", { status: 401 });

        const message = parsePayload(verified.body);
        // Acknowledge non-inbound events (delivery status, polls, etc.).
        if (!message) return new Response("ok");
        if (!(await isAllowed(message.sender, allowFrom))) {
          return new Response("forbidden", { status: 403 });
        }

        waitUntil(dispatch({ config, message, onMessage, send }));
        return new Response("ok");
      }),
    ],

    async receive(input, { send }) {
      const chatId = input.target.chatId;
      if (!chatId) throw new Error("blooioChannel().receive requires target.chatId.");
      const fromNumber = input.target.fromNumber ?? config.fromNumber ?? null;
      return send(input.message, {
        auth: input.auth,
        continuationToken: blooioContinuationToken(fromNumber ?? undefined, chatId),
        state: {
          chatId,
          internalId: fromNumber,
          isGroup: chatId.startsWith("grp_"),
          lastMessageId: null,
          sender: null,
        },
      });
    },

    events: mergedEvents,
  });
}

async function verifyInbound(
  req: Request,
  config: BlooioChannelConfig,
): Promise<{ body: string } | null> {
  try {
    return await verifyBlooioRequest(req, {
      timestampToleranceSec: config.timestampToleranceSec,
      webhookSecret: config.webhookSecret ?? config.credentials?.webhookSecret,
    });
  } catch (error) {
    log.warn("blooio inbound verification failed", { error });
    return null;
  }
}

function parsePayload(body: string): BlooioInboundMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    log.warn("blooio inbound body was not valid JSON", { error });
    return null;
  }
  return parseBlooioInboundMessage(parsed);
}

async function dispatch(input: {
  readonly config: BlooioChannelConfig;
  readonly message: BlooioInboundMessage;
  readonly onMessage: NonNullable<BlooioChannelConfig["onMessage"]>;
  readonly send: SendFn<BlooioChannelState>;
}): Promise<void> {
  const { config, message } = input;
  const handle = buildBlooioHandle({
    chatId: message.chatId,
    config,
    internalId: message.internalId,
    isGroup: message.isGroup,
    sender: message.sender,
  });

  if (config.markReadOnReceive) {
    try {
      await handle.markRead();
    } catch (error) {
      log.debug("blooio markRead on receive failed", { error });
    }
  }

  let result: BlooioInboundResult;
  try {
    result = await input.onMessage({ blooio: handle }, message);
  } catch (error) {
    log.error("blooio message handler failed", { error });
    return;
  }
  if (result === null || result === undefined) return;

  try {
    await input.send(
      {
        message: buildInboundMessageContent(message),
        context: [formatBlooioContextBlock(message)],
      },
      {
        auth: result.auth,
        continuationToken: blooioContinuationToken(message.internalId, message.chatId),
        state: {
          chatId: message.chatId,
          internalId: message.internalId ?? null,
          isGroup: message.isGroup,
          lastMessageId: message.messageId ?? null,
          sender: message.sender,
        },
      },
    );
  } catch (error) {
    log.error("blooio message delivery failed", { error });
  }
}

/**
 * Builds the delivery content for an inbound message. When the message
 * carries attachments, returns a multimodal `UserContent` array (text part
 * plus one file part per attachment) so the model can see the media.
 * Blooio serves inbound media from a public bucket, so the file-part URLs
 * pass straight through to the model provider. Text-only messages return
 * a plain string.
 */
function buildInboundMessageContent(message: BlooioInboundMessage): string | UserContent {
  const files = message.attachments.filter(
    (attachment): attachment is typeof attachment & { url: string } =>
      typeof attachment.url === "string" && attachment.url.length > 0,
  );
  if (files.length === 0) return message.text;

  const parts: Exclude<UserContent, string> = [];
  if (message.text) parts.push({ type: "text", text: message.text });
  for (const attachment of files) {
    parts.push({
      type: "file",
      data: new URL(attachment.url),
      mediaType: resolveAttachmentMediaType(attachment),
      ...(attachment.name ? { filename: attachment.name } : {}),
    });
  }
  return parts;
}

function buildBlooioHandle(input: {
  readonly chatId: string;
  readonly config: BlooioChannelConfig;
  readonly internalId: string | undefined;
  readonly isGroup: boolean;
  readonly sender: string | undefined;
}): BlooioHandle {
  const { config } = input;
  const shared = {
    baseUrl: config.baseUrl,
    credentials: config.credentials,
    fetch: config.fetch,
  };
  const defaultFrom = config.fromNumber ?? input.internalId;

  return {
    chatId: input.chatId,
    internalId: input.internalId,
    isGroup: input.isGroup,
    sender: input.sender,
    sendMessage(message, options) {
      return sendBlooioMessage({
        ...shared,
        attachments: options?.attachments,
        chatId: options?.chatId ?? input.chatId,
        effect: options?.effect,
        fromNumber: options?.fromNumber ?? defaultFrom,
        idempotencyKey: options?.idempotencyKey,
        replyToMessageId: options?.replyToMessageId,
        shareContact: options?.shareContact,
        text: message,
        useTypingIndicator: options?.useTypingIndicator,
      });
    },
    react(messageId, reaction, options) {
      return reactBlooioMessage({
        ...shared,
        chatId: options?.chatId ?? input.chatId,
        direction: options?.direction,
        messageId,
        reaction,
      });
    },
    startTyping(chatId) {
      return startBlooioTyping({ ...shared, chatId: chatId ?? input.chatId });
    },
    stopTyping(chatId) {
      return stopBlooioTyping({ ...shared, chatId: chatId ?? input.chatId });
    },
    markRead(chatId) {
      return markBlooioChatRead({ ...shared, chatId: chatId ?? input.chatId });
    },
    checkCapabilities(contact) {
      const target = contact ?? input.sender;
      if (!target) {
        throw new Error("blooioChannel: checkCapabilities requires a contact.");
      }
      return checkBlooioCapabilities({ ...shared, contact: target });
    },
    listMessages(options) {
      return listBlooioMessages({
        ...shared,
        ...options,
        chatId: options?.chatId ?? input.chatId,
      });
    },
    request(method, path, body, query) {
      return callBlooioApi({ ...shared, body, method, path, query });
    },
  };
}

async function isAllowed(sender: string, allowFrom: BlooioAllowFrom): Promise<boolean> {
  const resolved = typeof allowFrom === "function" ? await allowFrom() : allowFrom;
  if (resolved === "*") return true;
  return typeof resolved === "string" ? resolved === sender : resolved.includes(sender);
}
