import type { TelegramInstrumentationMetadata } from "#public/channels/telegram/index.js";
import { defaultDeliverResult, type ChannelAdapterContext } from "#channel/adapter.js";
import type { SessionHandle } from "#channel/session.js";
import type { DeliverPayload, SessionAuthContext } from "#channel/types.js";
import type { SessionContext } from "#public/definitions/callback-context.js";
import type { ChannelSessionOps } from "#public/definitions/channel.js";
import { isCompiledChannel } from "#channel/compiled-channel.js";
import { createLogger, logError } from "#internal/logging.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import {
  answerTelegramCallbackQuery,
  callTelegramApi,
  editTelegramMessageReplyMarkup,
  sendTelegramChatAction,
  sendTelegramMessage,
  splitTelegramMessageText,
  telegramContinuationToken,
  type TelegramApiOptions,
  type TelegramApiResponse,
  type TelegramCredentials,
  type TelegramMessageBody,
  type TelegramMessageResult,
} from "#public/channels/telegram/api.js";
import {
  buildTelegramTurnMessage,
  collectTelegramFileParts,
  createTelegramFetchFile,
} from "#public/channels/telegram/attachments.js";
import { defaultEvents, defaultOnMessage } from "#public/channels/telegram/defaults.js";
import {
  TELEGRAM_HITL_CALLBACK_PREFIX,
  isTelegramSyntheticResponse,
  resolveTelegramInputResponses,
  telegramCallbackInputResponse,
  telegramReplyInputResponse,
  type TelegramHitlState,
} from "#public/channels/telegram/hitl.js";
import {
  formatTelegramContextBlock,
  parseTelegramUpdate,
  type TelegramCallbackQuery,
  type TelegramChatType,
  type TelegramMessage,
} from "#public/channels/telegram/inbound.js";
import {
  mergeUploadPolicy,
  type UploadPolicy,
  type UploadPolicyInput,
} from "#public/channels/upload-policy.js";
import {
  verifyTelegramRequest,
  type TelegramWebhookSecretToken,
  type TelegramWebhookVerifier,
} from "#public/channels/telegram/verify.js";
import { defineChannel, POST, type Channel, type SendFn } from "#public/definitions/channel.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";

const log = createLogger("telegram.channel");

type EventData<T extends HandleMessageStreamEvent["type"]> =
  Extract<HandleMessageStreamEvent, { type: T }> extends { data: infer D } ? D : undefined;

/** Minimal Telegram context (only `telegram`, no `state` or session ops), passed to `onMessage` and `onCallbackQuery` hooks before a session exists. Event handlers receive the richer {@link TelegramEventContext}. */
export interface TelegramContext {
  readonly telegram: TelegramHandle;
}

/** Channel-owned Telegram context returned by `context()`. */
export interface TelegramChannelContext extends TelegramContext {
  state: TelegramChannelState;
}

/** Event-handler Telegram context, including session operations. */
export interface TelegramEventContext extends TelegramChannelContext, ChannelSessionOps {}

/** JSON-serializable Telegram channel state. */
export interface TelegramChannelState extends TelegramHitlState {
  /** Telegram bot username used for group mention detection, when configured. */
  botUsername?: string | null;
  /** Telegram chat id. */
  chatId: string | null;
  /** Telegram chat type, when known from an inbound update. */
  chatType: TelegramChatType | null;
  /** Group/supergroup conversation anchor message id. */
  conversationId: string | null;
  /** Forum topic id, when known. */
  messageThreadId: number | null;
  /** Telegram user id that triggered the current session/turn. */
  triggeringUserId?: string | null;
}

/** Telegram channel credentials. `webhookVerifier` is a custom inbound webhook verifier for forwarded webhooks. */
export interface TelegramChannelCredentials extends TelegramCredentials {
  /** Webhook secret token configured via setWebhook. Falls back to `TELEGRAM_WEBHOOK_SECRET_TOKEN` when neither this nor `webhookVerifier` is set. */
  readonly webhookSecretToken?: TelegramWebhookSecretToken;
  readonly webhookVerifier?: TelegramWebhookVerifier;
}

/** Target for `receive(telegram, { target })` proactive sessions. `chatId` is required. `conversationId` resumes an existing thread; `initialMessage` posts a seed message and starts a new thread from it. The two are mutually exclusive: supplying both throws. */
export interface TelegramReceiveTarget {
  readonly chatId: number | string;
  readonly conversationId?: number | string;
  readonly initialMessage?: string | TelegramMessageBody;
  readonly messageThreadId?: number;
}

/** Result of an inbound Telegram message hook. Return `null` to drop the update. */
export type TelegramInboundResult = {
  readonly auth: SessionAuthContext | null;
  readonly context?: readonly string[];
} | null;

/** Sync or async {@link TelegramInboundResult}. */
export type TelegramInboundResultOrPromise = TelegramInboundResult | Promise<TelegramInboundResult>;

type TelegramEventHandler<T extends HandleMessageStreamEvent["type"]> = (
  data: EventData<T>,
  channel: TelegramEventContext,
  ctx: SessionContext,
) => void | Promise<void>;

type TelegramSessionFailedHandler = (
  data: EventData<"session.failed">,
  channel: TelegramEventContext,
) => void | Promise<void>;

/** Per-event handlers for `telegramChannel({ events })`. Each entry overrides the built-in default (handlers merge over {@link defaultEvents}). `session.failed` receives `(data, channel)`; all others also receive the {@link SessionContext}. */
export interface TelegramChannelEvents {
  readonly "turn.started"?: TelegramEventHandler<"turn.started">;
  readonly "actions.requested"?: TelegramEventHandler<"actions.requested">;
  readonly "action.result"?: TelegramEventHandler<"action.result">;
  readonly "message.completed"?: TelegramEventHandler<"message.completed">;
  readonly "message.appended"?: TelegramEventHandler<"message.appended">;
  readonly "input.requested"?: TelegramEventHandler<"input.requested">;
  readonly "turn.failed"?: TelegramEventHandler<"turn.failed">;
  readonly "turn.completed"?: TelegramEventHandler<"turn.completed">;
  readonly "turn.cancelled"?: TelegramEventHandler<"turn.cancelled">;
  readonly "session.failed"?: TelegramSessionFailedHandler;
  readonly "session.completed"?: TelegramEventHandler<"session.completed">;
  readonly "session.waiting"?: TelegramEventHandler<"session.waiting">;
  readonly "authorization.required"?: TelegramEventHandler<"authorization.required">;
  readonly "authorization.completed"?: TelegramEventHandler<"authorization.completed">;
}

/** Configuration for {@link telegramChannel}. */
export interface TelegramChannelConfig {
  /** API transport overrides (base URLs, custom fetch). Credentials are supplied separately via `credentials`. */
  readonly api?: Omit<TelegramApiOptions, "credentials">;
  /** Bot username (without `@`) used to detect mentions and `/command@bot` in group chats. */
  readonly botUsername?: string;
  /** Bot token and inbound webhook verification settings. */
  readonly credentials?: TelegramChannelCredentials;
  /** Per-event handler overrides. See {@link TelegramChannelEvents}. */
  readonly events?: TelegramChannelEvents;
  /** Handler for non-HITL callback queries. */
  readonly onCallbackQuery?: (
    ctx: TelegramContext,
    query: TelegramCallbackQuery,
  ) => void | Promise<void>;
  /** Inbound message hook. Defaults to Telegram user auth and dispatch gating. */
  readonly onMessage?: (
    ctx: TelegramContext,
    message: TelegramMessage,
  ) => TelegramInboundResultOrPromise;
  /** Override the default webhook route path (`/eve/v1/telegram`). */
  readonly route?: string;
  /** Inbound upload policy for Telegram photos and documents. */
  readonly uploadPolicy?: UploadPolicyInput;
}

/** Low-level Telegram handle on every channel context as `ctx.telegram`. `request` issues a raw Bot API call by method name and returns the decoded response. `post` and `sendMessage` are identical: each sends a message, splitting text over the 4096-character cap into multiple messages and resolving to the first. `startTyping` sends a chat action (defaults to `typing`) and never throws: it logs and swallows failures. */
export interface TelegramHandle {
  readonly botUsername: string | undefined;
  readonly chatId: string;
  readonly chatType: TelegramChatType | undefined;
  readonly conversationId: string | undefined;
  readonly messageThreadId: number | undefined;

  request(method: string, body?: JsonObject): Promise<TelegramApiResponse>;
  post(message: string | TelegramMessageBody): Promise<TelegramMessageResult>;
  sendMessage(message: string | TelegramMessageBody): Promise<TelegramMessageResult>;
  startTyping(action?: string): Promise<void>;
  answerCallbackQuery(input: {
    readonly callbackQueryId: string;
    readonly showAlert?: boolean;
    readonly text?: string;
  }): Promise<TelegramApiResponse>;
  editMessageReplyMarkup(input: {
    readonly messageId: number | string;
    readonly replyMarkup?: Readonly<Record<string, unknown>>;
  }): Promise<TelegramApiResponse>;
}

/** Concrete return type of {@link telegramChannel}. */
export interface TelegramChannel extends Channel<
  TelegramChannelState,
  TelegramReceiveTarget,
  TelegramInstrumentationMetadata
> {}

/** Telegram channel factory for webhook updates and proactive messages. */
export function telegramChannel(config: TelegramChannelConfig = {}): TelegramChannel {
  const uploadPolicy = mergeUploadPolicy(config.uploadPolicy);
  const onMessage = config.onMessage ?? defaultOnMessage;
  const mergedEvents: TelegramChannelEvents = { ...defaultEvents, ...config.events };

  const channel = defineChannel<
    TelegramChannelState,
    TelegramChannelContext,
    TelegramReceiveTarget,
    TelegramInstrumentationMetadata
  >({
    kindHint: "telegram",
    state: initialTelegramState(config.botUsername),
    metadata: (state) => ({
      chatId: state.chatId,
      chatType: state.chatType,
      triggeringUserId: state.triggeringUserId ?? null,
    }),
    fetchFile: createTelegramFetchFile({
      api: config.api,
      credentials: config.credentials,
      policy: uploadPolicy,
    }),

    context(state, session) {
      return rebuildTelegramContext(state, session, config);
    },

    routes: [
      POST<TelegramChannelState>(
        config.route ?? "/eve/v1/telegram",
        async (req, { send, waitUntil }) => {
          const body = await verifyInbound(req, config.credentials);
          if (body === null) return new Response("unauthorized", { status: 401 });

          let raw: JsonObject;
          try {
            raw = parseJsonObject(JSON.parse(body) as unknown);
          } catch (error) {
            log.warn("inbound Telegram body is not valid JSON", { error });
            return new Response("ok");
          }

          const update = parseTelegramUpdate(raw);
          if (update === null) return new Response("ok");

          if (update.kind === "message") {
            waitUntil(
              dispatchMessage({
                config,
                message: update.message,
                onMessage,
                send,
                uploadPolicy,
              }),
            );
            return new Response("ok");
          }

          waitUntil(
            dispatchCallbackQuery({
              config,
              query: update.callbackQuery,
              send,
            }),
          );
          return new Response("ok");
        },
      ),
    ],

    async receive(input, { send }) {
      const receiveTarget = input.target as Partial<TelegramReceiveTarget>;
      const chatId = readChatId(receiveTarget.chatId);
      if (chatId === undefined) {
        throw new Error("telegramChannel().receive requires target.chatId.");
      }
      const messageThreadId =
        typeof receiveTarget.messageThreadId === "number"
          ? receiveTarget.messageThreadId
          : undefined;
      const requestedConversationId = readOptionalString(receiveTarget.conversationId);
      const initialMessage = receiveTarget.initialMessage;
      if (initialMessage !== undefined && requestedConversationId !== undefined) {
        throw new Error(
          "telegramChannel().receive: `conversationId` and `initialMessage` are mutually exclusive.",
        );
      }

      const receiveState: TelegramChannelState = {
        ...initialTelegramState(config.botUsername),
        chatId,
        conversationId: requestedConversationId ?? null,
        messageThreadId: messageThreadId ?? null,
      };

      if (initialMessage !== undefined) {
        const handle = buildTelegramHandle({
          config,
          state: receiveState,
        });
        await handle.sendMessage(initialMessage);
      }

      return send(input.message, {
        auth: input.auth,
        continuationToken: continuationTokenFromState(receiveState),
        state: receiveState,
      });
    },

    events: mergedEvents,
  });

  attachTelegramDeliver(channel);
  return channel;
}

function rebuildTelegramContext(
  state: TelegramChannelState,
  session: SessionHandle,
  config: TelegramChannelConfig,
): TelegramChannelContext {
  return {
    state,
    telegram: buildTelegramHandle({ config, session, state }),
  };
}

function buildTelegramHandle(input: {
  readonly config: TelegramChannelConfig;
  readonly session?: SessionHandle;
  readonly state: TelegramChannelState;
}): TelegramHandle {
  const api = input.config.api;
  const state = input.state;
  const credentials = input.config.credentials;

  function anchor(posted: TelegramMessageResult): void {
    const chatType = state.chatType ?? posted.chatType ?? null;
    if (state.chatType === null && posted.chatType !== undefined) {
      state.chatType = posted.chatType;
    }
    if (!posted.id || !shouldAnchorTelegramConversation(chatType)) return;
    state.conversationId = posted.id;
    if (state.chatId) {
      input.session?.setContinuationToken(
        telegramContinuationToken({
          chatId: state.chatId,
          conversationId: posted.id,
          messageThreadId: state.messageThreadId ?? undefined,
        }),
      );
    }
  }

  async function sendOne(body: TelegramMessageBody): Promise<TelegramMessageResult> {
    const chatId = state.chatId ?? "";
    if (!chatId) throw new Error("telegramChannel: missing chat id for outbound message.");
    const posted = await sendTelegramMessage({
      apiBaseUrl: api?.apiBaseUrl,
      body: {
        ...body,
        message_thread_id: body.message_thread_id ?? state.messageThreadId ?? undefined,
      },
      credentials,
      fetch: api?.fetch,
      fileBaseUrl: api?.fileBaseUrl,
      chatId,
    });
    anchor(posted);
    return posted;
  }

  return {
    botUsername: state.botUsername ?? input.config.botUsername,
    chatId: state.chatId ?? "",
    chatType: state.chatType ?? undefined,
    conversationId: state.conversationId ?? undefined,
    messageThreadId: state.messageThreadId ?? undefined,
    answerCallbackQuery(query) {
      return answerTelegramCallbackQuery({
        apiBaseUrl: api?.apiBaseUrl,
        callbackQueryId: query.callbackQueryId,
        credentials,
        fetch: api?.fetch,
        showAlert: query.showAlert,
        text: query.text,
      });
    },
    editMessageReplyMarkup(args) {
      const chatId = state.chatId ?? "";
      if (!chatId) throw new Error("telegramChannel: missing chat id for reply-markup edit.");
      return editTelegramMessageReplyMarkup({
        apiBaseUrl: api?.apiBaseUrl,
        chatId,
        credentials,
        fetch: api?.fetch,
        messageId: args.messageId,
        replyMarkup: args.replyMarkup,
      });
    },
    post(message) {
      return postTelegramMessage(message, sendOne);
    },
    request(method, body) {
      return callTelegramApi({
        apiBaseUrl: api?.apiBaseUrl,
        body,
        botToken: credentials?.botToken,
        fetch: api?.fetch,
        method,
      });
    },
    sendMessage(message) {
      return postTelegramMessage(message, sendOne);
    },
    async startTyping(action = "typing") {
      const chatId = state.chatId ?? "";
      if (!chatId) return;
      try {
        await sendTelegramChatAction({
          action,
          apiBaseUrl: api?.apiBaseUrl,
          chatId,
          credentials,
          fetch: api?.fetch,
          messageThreadId: state.messageThreadId ?? undefined,
        });
      } catch (error) {
        logError(log, "Telegram typing indicator failed — swallowed", error, { chatId });
      }
    },
  };
}

function shouldAnchorTelegramConversation(chatType: TelegramChatType | null): boolean {
  return chatType === "group" || chatType === "supergroup";
}

async function postTelegramMessage(
  message: string | TelegramMessageBody,
  sendOne: (body: TelegramMessageBody) => Promise<TelegramMessageResult>,
): Promise<TelegramMessageResult> {
  const body = typeof message === "string" ? { text: message } : message;
  const chunks = splitTelegramMessageText(body.text);
  let first: TelegramMessageResult | undefined;

  for (const [index, text] of chunks.entries()) {
    const posted = await sendOne(index === 0 ? { ...body, text } : { text });
    if (first === undefined) first = posted;
  }

  return first ?? { id: "", raw: null };
}

async function verifyInbound(
  req: Request,
  credentials: TelegramChannelCredentials | undefined,
): Promise<string | null> {
  try {
    return await verifyTelegramRequest(req, {
      secretToken: credentials?.webhookVerifier ? undefined : credentials?.webhookSecretToken,
      webhookVerifier: credentials?.webhookVerifier,
    });
  } catch (error) {
    log.warn("telegram inbound verification failed", { error });
    return null;
  }
}

async function dispatchMessage(input: {
  readonly config: TelegramChannelConfig;
  readonly message: TelegramMessage;
  readonly onMessage: NonNullable<TelegramChannelConfig["onMessage"]>;
  readonly send: SendFn<TelegramChannelState>;
  readonly uploadPolicy: UploadPolicy;
}): Promise<void> {
  if (input.message.from?.isBot === true) return;

  const state = stateFromMessage(input.message, input.config);
  const telegram: TelegramContext = {
    telegram: buildTelegramHandle({ config: input.config, state }),
  };

  let result: TelegramInboundResult;
  try {
    result = await input.onMessage(telegram, input.message);
  } catch (error) {
    log.error("message handler failed", { error });
    return;
  }
  if (result === null || result === undefined) return;

  const fileParts = collectTelegramFileParts(input.message.attachments, input.uploadPolicy);
  const turnMessage = buildTelegramTurnMessage(input.message, fileParts);
  const contextBlock = formatTelegramContextBlock({
    botUsername: input.config.botUsername,
    chatId: input.message.chat.id,
    chatTitle: input.message.chat.title,
    chatType: input.message.chat.type,
    messageId: input.message.messageId,
    messageThreadId: input.message.messageThreadId,
    userId: input.message.from?.id,
    username: input.message.from?.username,
  });
  const channelContext = result.context ?? [];

  const replyText = input.message.text || input.message.caption;
  const replyInputResponses =
    input.message.replyToMessage?.from?.isBot === true && replyText.trim().length > 0
      ? [
          telegramReplyInputResponse({
            messageId: input.message.replyToMessage.messageId,
            text: replyText,
          }),
        ]
      : undefined;

  try {
    await input.send(
      {
        inputResponses: replyInputResponses,
        message: turnMessage,
        context: [contextBlock, ...channelContext],
      },
      {
        auth: result.auth,
        continuationToken: continuationTokenFromState(state),
        state,
      },
    );
  } catch (error) {
    log.error("message delivery failed", { error });
  }
}

async function dispatchCallbackQuery(input: {
  readonly config: TelegramChannelConfig;
  readonly query: TelegramCallbackQuery;
  readonly send: SendFn<TelegramChannelState>;
}): Promise<void> {
  const state = stateFromCallbackQuery(input.query, input.config);
  const telegram: TelegramContext = {
    telegram: buildTelegramHandle({ config: input.config, state }),
  };

  if (input.query.data?.startsWith(TELEGRAM_HITL_CALLBACK_PREFIX) === true) {
    try {
      await telegram.telegram.answerCallbackQuery({
        callbackQueryId: input.query.id,
        text: "Answer received.",
      });
    } catch (error) {
      log.warn("Telegram callback-query acknowledgement failed", { error });
    }

    if (!input.query.message || !state.chatId) return;
    try {
      await input.send(
        {
          inputResponses: [telegramCallbackInputResponse(input.query.data)],
        },
        {
          auth: null,
          continuationToken: continuationTokenFromState(state),
          state,
        },
      );
    } catch (error) {
      log.error("callback query delivery failed", { error });
    }
    return;
  }

  if (input.config.onCallbackQuery !== undefined) {
    try {
      await input.config.onCallbackQuery(telegram, input.query);
    } catch (error) {
      log.error("custom callback-query handler failed", { error });
    }
    return;
  }

  try {
    await telegram.telegram.answerCallbackQuery({
      callbackQueryId: input.query.id,
      text: "Unsupported action.",
    });
  } catch (error) {
    log.warn("Telegram unsupported callback-query acknowledgement failed", { error });
  }
}

function attachTelegramDeliver(channel: TelegramChannel): void {
  if (!isCompiledChannel(channel)) return;
  const adapter = channel.adapter;
  adapter.deliver = (payload: DeliverPayload, ctx: ChannelAdapterContext<TelegramChannelState>) => {
    const responses = payload.inputResponses ?? [];
    if (responses.some(isTelegramSyntheticResponse)) {
      const resolved = resolveTelegramInputResponses(ctx.state, responses);
      if (resolved.length > 0) {
        return { inputResponses: resolved, context: payload.context };
      }
      if (payload.message !== undefined) {
        return { message: payload.message, context: payload.context };
      }
      return undefined;
    }
    return defaultDeliverResult(payload);
  };
}

function stateFromMessage(
  message: TelegramMessage,
  config: TelegramChannelConfig,
): TelegramChannelState {
  const privateChat = message.chat.type === "private";
  return {
    ...initialTelegramState(config.botUsername),
    chatId: message.chat.id,
    chatType: message.chat.type,
    conversationId: privateChat ? null : conversationIdForMessage(message),
    messageThreadId: message.messageThreadId ?? null,
    triggeringUserId: message.from?.id ?? null,
  };
}

function stateFromCallbackQuery(
  query: TelegramCallbackQuery,
  config: TelegramChannelConfig,
): TelegramChannelState {
  const message = query.message;
  if (!message) {
    return {
      ...initialTelegramState(config.botUsername),
      triggeringUserId: query.from.id,
    };
  }
  const privateChat = message.chat.type === "private";
  return {
    ...initialTelegramState(config.botUsername),
    chatId: message.chat.id,
    chatType: message.chat.type,
    conversationId: privateChat ? null : message.messageId,
    messageThreadId: message.messageThreadId ?? null,
    triggeringUserId: query.from.id,
  };
}

function conversationIdForMessage(message: TelegramMessage): string {
  if (message.replyToMessage?.from?.isBot === true) {
    return message.replyToMessage.messageId;
  }
  return message.messageId;
}

function continuationTokenFromState(state: TelegramChannelState): string {
  const chatId = state.chatId ?? "";
  return telegramContinuationToken({
    chatId,
    conversationId: state.chatType === "private" ? undefined : (state.conversationId ?? undefined),
    messageThreadId: state.messageThreadId ?? undefined,
  });
}

function initialTelegramState(botUsername: string | undefined): TelegramChannelState {
  return {
    botUsername: botUsername ?? null,
    chatId: null,
    chatType: null,
    conversationId: null,
    hitlCallbacks: {},
    messageThreadId: null,
    nextHitlCallbackId: 0,
    pendingFreeformReplies: {},
    triggeringUserId: null,
  };
}

function readChatId(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}
