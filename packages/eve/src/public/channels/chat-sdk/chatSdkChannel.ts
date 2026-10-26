import { sessionTables } from "#protocol/session-projection/session-view.js";
import { failureNotice } from "#public/channels/reply.js";
import { callLabel } from "#protocol/session-projection/selectors.js";
import { contentPhase } from "#protocol/session-events/catalog.js";
import { type PromptQueueState, promptQueue } from "#channel/prompt-queue.js";
import type { MessageContent } from "#shared/message-content.js";

import type {
  ChannelFrom,
  ChannelRespondOptions,
  ChannelSendOptions,
} from "#channel/channel-operations.js";
import type { ChannelDelivery } from "#shared/channel-delivery.js";
import type { ChannelContext } from "#shared/channel-context.js";
import {
  INACTIVE_REQUEST_NOTICE,
  respondOrRetireInactivePrompt,
} from "#channel/inactive-prompt.js";
import type { SessionAuthContext, TurnPolicy } from "#channel/types.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import { EveAttachmentError } from "#internal/attachments/errors.js";
import { assertWithinLimit } from "#internal/attachments/limited-read.js";
import { createLogger } from "#internal/logging.js";
import type { RequestSettlement } from "#channel/interaction-prompts.js";
import type { FetchFileResult } from "#shared/channel-definition.js";
import type { Interaction } from "#channel/interaction-prompts.js";
import { type Answer, parseAnswers, type StrictAnswers } from "#shared/input.js";
import type {
  ActionEvent,
  Adapter,
  ChatConfig,
  SerializedThread,
  Thread,
  WebhookOptions,
} from "#compiled/chat/index.js";
import { Chat, Message, ThreadImpl } from "#compiled/chat/index.js";
import { chatSdkSignIns } from "#public/channels/chat-sdk/authorization.js";
import { requestSettlementOf } from "#channel/interaction-prompts.js";
import { settleSignIn, showSignIn } from "#channel/sign-in.js";
import { parseChatSdkFileRef } from "#public/channels/chat-sdk/attachment-refs.js";
import {
  decodeInputAction,
  renderInteractions,
  renderRetiredInputRequest,
} from "#public/channels/chat-sdk/input-actions.js";
import {
  reportUndeliveredReply,
  type UndeliveredReplyState,
  withUndeliveredReplyNote,
} from "#public/channels/undelivered-reply.js";
import { DEFAULT_UPLOAD_POLICY } from "#public/channels/upload-policy.js";
import { isNotImplemented } from "#public/channels/chat-sdk/notImplemented.js";
import {
  defineChannel,
  GET,
  POST,
  type Channel,
  type ChannelEvents,
  type ChannelContinuationOps,
  type RouteHandlerArgs,
  type Delivery,
} from "#public/definitions/channel.js";
import { chatSdkInstrumentation } from "#public/channels/chat-sdk/audience.js";

const log = createLogger("chat-sdk.channel");
const DEFAULT_ROUTE = "/eve/v1";
const DEFAULT_INPUT_ACTION_PREFIX = "eve_input:";
const DEFAULT_STREAMING_EDIT_INTERVAL_MS = 1_000;
const MAX_TYPING_STATUS = 80;
/** How the undelivered-reply notice and model note name a Chat SDK surface. */
const SURFACE_NAME = "this chat";

type ChatSdkAdapters = Record<string, Adapter>;
interface ActiveWebhookContext {
  readonly from: ChannelFrom<ChatSdkChannelState>;
}

const ActiveWebhookKey = new ContextKey<ActiveWebhookContext>("chat-sdk.active-webhook");

/** Durable Chat SDK thread state plus default-handler streaming bookkeeping. */
export interface ChatSdkChannelState
  extends Record<string, unknown>, PromptQueueState, UndeliveredReplyState {
  thread: SerializedThread | null;
  /** Message id of the in-flight streamed assistant post (edit fallback). */
  anchorMessageId?: string | null;
  /** Text streamed for the anchor so far, including deltas no throttled edit has shown yet. */
  streamText?: string | null;
  /** Text the anchor showed after its last successful post or edit. */
  shownText?: string | null;
  /**
   * Whether `adapter.editMessage` works for this session. Set to `false` once
   * an edit throws {@link isNotImplemented}, which disables streaming edits for
   * the rest of the session.
   */
  editSupported?: boolean;
  /** Epoch ms of the last streaming edit, used to throttle edits. */
  lastEditAtMs?: number | null;
  /** Buffered first line of a tool-call message, surfaced as typing status. */
  pendingToolCallMessage?: string | null;
  /** Authorization status messages, keyed by connection name. */
  pendingAuthMessageIds?: Record<string, string>;
  /**
   * The Chat SDK user behind each principal that sent a message, so a sign-in
   * reaches them privately. `null` once more than one person sent as it.
   */
  usersByPrincipal?: Record<string, string | null>;
  /** Posted input request cards, keyed by message id, until eve resolves every request on them. */
  pendingInputCards?: Record<string, ChatSdkPendingInputCard>;
  streamPartId?: string | null;
  /** Id of the latest message someone other than the bot sent in the thread. */
  latestMessageId?: string;
}

/** One posted card's requests and the resolutions eve has reported for them so far. */
export interface ChatSdkPendingInputCard {
  readonly requests: readonly Interaction[];
  readonly resolved: Readonly<Record<string, RequestSettlement>>;
}

/**
 * Thread selector accepted by `chatSdkChannel().receive`. Pass a serialized
 * Chat SDK thread when possible; `threadId` plus `adapterName` is supported for
 * proactive sends that only have a provider-native thread id.
 */
export interface ChatSdkReceiveTarget {
  readonly adapterName?: string;
  readonly thread?: SerializedThread;
  readonly threadId?: string;
}

/**
 * Channel-owned metadata exposed to eve instrumentation.
 */
export interface ChatSdkInstrumentationMetadata extends Record<string, unknown> {
  readonly adapterName: string | null;
  readonly channelId: string | null;
  readonly isDM: boolean | null;
  readonly threadId: string | null;
}

/**
 * Per-session context passed to `chatSdkChannel({ events })` handlers. `thread`
 * is rebuilt from persisted channel state using the configured Chat SDK
 * adapter, so default handlers can post back to the originating chat thread.
 */
export interface ChatSdkChannelContext<TAdapters extends ChatSdkAdapters = ChatSdkAdapters> {
  readonly bot: Chat<TAdapters>;
  readonly thread: Thread | null;
  state: ChatSdkChannelState;
  /** Whether streamed deltas are delivered via a post+edit fallback. */
  readonly streaming: boolean;
  /** Minimum interval between streaming edits, in ms. */
  readonly streamingEditIntervalMs: number;
}

/** Event-handler context for `chatSdkChannel`, including continuation routing. */
export interface ChatSdkEventContext<TAdapters extends ChatSdkAdapters = ChatSdkAdapters>
  extends ChatSdkChannelContext<TAdapters>, ChannelContinuationOps {}

/**
 * Per-event handlers for `chatSdkChannel({ events })`. Each supplied handler
 * replaces the built-in default for that event.
 */
export type ChatSdkChannelEvents<TAdapters extends ChatSdkAdapters = ChatSdkAdapters> =
  ChannelEvents<ChatSdkChannelContext<TAdapters>>;

/** Selects the Chat SDK thread that owns the eve continuation token. */
interface ChatSdkThreadOptions {
  readonly auth?: SessionAuthContext | null;
  readonly thread: SerializedThread | Thread | string;
  /**
   * Required when `thread` is a string that does not include the Chat SDK
   * adapter prefix. Prefer passing the `Thread` object from the Chat SDK handler
   * when possible.
   */
  readonly adapterName?: string;
}

/**
 * Options for `bridge.send`: channel send options plus the thread. The thread
 * determines the eve continuation token and persisted channel state.
 */
export interface ChatSdkSendOptions extends ChatSdkThreadOptions, Omit<ChannelSendOptions, "auth"> {
  /**
   * Answers the input request on the card eve posted as `messageId` with
   * `optionId`, when that card is still waiting on it. Otherwise eve delivers
   * the message as usual.
   */
  readonly inputAnswer?: ChatSdkInputAnswer;
  /**
   * Controls how this input interacts with an active eve turn on the same
   * thread. Defaults to the channel's `turnPolicy`, then `"steer"`.
   */
  readonly turnPolicy?: TurnPolicy;
}

/** An option chosen for the input request card posted as `messageId`. */
export interface ChatSdkInputAnswer {
  readonly messageId: string;
  readonly optionId: string;
}

/** Options for `bridge.respond`: channel respond options plus the thread. */
export interface ChatSdkRespondOptions
  extends ChatSdkThreadOptions, Omit<ChannelRespondOptions, "auth" | "state"> {}

/**
 * Configuration for {@link chatSdkChannel}. It accepts normal Chat SDK
 * `ChatConfig` fields, plus eve route and event settings.
 */
export interface ChatSdkChannelConfig<
  TAdapters extends ChatSdkAdapters = ChatSdkAdapters,
> extends Omit<ChatConfig<TAdapters>, "adapters"> {
  /** Map of Chat SDK adapter name to adapter instance. */
  readonly adapters: TAdapters;
  /**
   * Base route for generated adapter webhooks. Defaults to `/eve/v1`, so an
   * adapter named `slack` mounts at `/eve/v1/slack`.
   */
  readonly route?: string;
  /**
   * Per-adapter route overrides. Use when a provider requires a fixed webhook
   * URL or when migrating an existing endpoint without changing provider
   * settings.
   */
  readonly routes?: Partial<Record<Extract<keyof TAdapters, string>, string>>;
  /** Policy for accepted messages that arrive while a turn is active. */
  readonly turnPolicy?: TurnPolicy;
  /** Extra Chat SDK webhook options. eve owns `waitUntil`. */
  readonly webhook?: Omit<WebhookOptions, "waitUntil">;
  /** Optional eve event handlers. Supplied handlers replace built-in defaults. */
  readonly events?: ChatSdkChannelEvents<TAdapters>;
  /**
   * Prefix for default eve HITL button action ids. Change this if your Chat SDK
   * app already uses the `eve_input:` prefix.
   */
  readonly inputActionPrefix?: string;
  /**
   * Auth resolver for default HITL button clicks. Defaults to `null`; provide a
   * resolver when continued sessions should keep user or tenant auth.
   */
  readonly resolveInputAuth?: (
    event: ActionEvent,
  ) => SessionAuthContext | null | Promise<SessionAuthContext | null>;
  /**
   * Whether the default handlers stream assistant output by posting an initial
   * message and editing it as deltas arrive. Defaults to `true`. Set to `false`
   * for adapters that only deliver a single message per turn (e.g. email), so
   * replies post once on completion.
   */
  readonly streaming?: boolean;
  /**
   * Minimum interval between streaming edits, in ms. Defaults to `1000`. Only
   * used when `streaming` is enabled and the adapter supports editing.
   */
  readonly streamingEditIntervalMs?: number;
}

/** Concrete channel value returned on `bridge.channel`. */
export interface ChatSdkChannel extends Channel<
  ChatSdkChannelState,
  ChatSdkReceiveTarget,
  ChatSdkInstrumentationMetadata
> {}

/**
 * Return value of {@link chatSdkChannel}. Export `channel` from
 * `agent/channels/<name>.ts`, then register handlers on `bot` and call `send`
 * from those handlers to hand work to eve.
 */
export interface ChatSdkChannelBridge<TAdapters extends ChatSdkAdapters = ChatSdkAdapters> {
  readonly bot: Chat<TAdapters>;
  readonly channel: ChatSdkChannel;
  /**
   * Starts or resumes an eve session from inside a Chat SDK webhook handler.
   * Use `channel.receive(...)` for proactive sends that are not handling an
   * inbound Chat SDK webhook.
   */
  send(message: MessageContent, options: ChatSdkSendOptions): Promise<Delivery>;
  /**
   * Answers pending input requests on the thread's session from inside a Chat
   * SDK webhook handler. Never creates a session.
   */
  respond<const TResponses extends readonly Answer[]>(
    answers: StrictAnswers<TResponses>,
    options: ChatSdkRespondOptions,
  ): Promise<Delivery>;
}

/**
 * Creates an eve channel backed by one Chat SDK runtime and its adapters.
 *
 * @example
 * ```ts
 * import { createSlackAdapter } from "@chat-adapter/slack";
 * import { createMemoryState } from "@chat-adapter/state-memory";
 * import { chatSdkChannel } from "eve/channels/chat-sdk";
 *
 * export const { bot, channel, send } = chatSdkChannel({
 *   userName: "acme",
 *   adapters: { slack: createSlackAdapter() },
 *   state: createMemoryState(),
 * });
 *
 * bot.onNewMention(async (thread, message) => {
 *   await send(message.text, { thread });
 * });
 * ```
 */
export function chatSdkChannel<TAdapters extends ChatSdkAdapters>(
  config: ChatSdkChannelConfig<TAdapters>,
): ChatSdkChannelBridge<TAdapters> {
  const bot = new Chat<TAdapters>(config as ChatConfig<TAdapters>);
  const inputActionPrefix = config.inputActionPrefix ?? DEFAULT_INPUT_ACTION_PREFIX;
  const streaming = config.streaming ?? true;
  const streamingEditIntervalMs =
    config.streamingEditIntervalMs ?? DEFAULT_STREAMING_EDIT_INTERVAL_MS;
  const mergedEvents: ChatSdkChannelEvents<TAdapters> = {
    ...defaultEvents<TAdapters>(inputActionPrefix),
    ...config.events,
  };

  bot.onAction(async (event: ActionEvent) => {
    const response = decodeInputAction(event.actionId, inputActionPrefix, event.value);
    if (!response) return;
    const { thread } = event;
    if (!thread) {
      throw new Error(
        "chatSdkChannel input actions require a thread on the Chat SDK action event.",
      );
    }
    const auth = config.resolveInputAuth ? await config.resolveInputAuth(event) : null;
    const answer = await respondOrRetireInactivePrompt(
      () => bridgeRespond(bot, [response], { auth, thread: thread.toJSON() }),
      {
        retirePrompt: (label) => retireInputCard(thread, event.messageId, label),
      },
      log,
    );
    // Chat SDK stops its action handlers at a throw, as it did before inactive
    // presses were told apart from other failures.
    if (answer.outcome === "failed") throw answer.error;
    if (answer.outcome === "delivered") return;
    await Promise.all([
      answer.retirement,
      thread
        .postEphemeral(event.user, { markdown: INACTIVE_REQUEST_NOTICE }, { fallbackToDM: true })
        .catch((error: unknown) => log.error("inactive prompt notice failed", { error })),
    ]);
  });

  const channel = defineChannel<
    ChatSdkChannelState,
    ChatSdkChannelContext<TAdapters>,
    ChatSdkReceiveTarget,
    ChatSdkInstrumentationMetadata
  >({
    turnPolicy: config.turnPolicy,
    fetchFile: (url) => fetchAttachment(bot, url),
    state: initialState(),
    ...chatSdkInstrumentation,
    context(state) {
      return {
        bot,
        state,
        streaming,
        streamingEditIntervalMs,
        thread: threadFromState(bot, state),
      };
    },
    // Register both methods on each adapter's webhook path. Providers such as X
    // verify ownership with a GET challenge (CRC) and deliver events via POST;
    // the adapter dispatches on request.method, so one handler serves both.
    routes: adapterNames(config.adapters).flatMap((adapterName) => {
      const path = routeForAdapter(adapterName, config);
      const handler = async (
        request: Request,
        args: RouteHandlerArgs<ChatSdkChannelState>,
      ): Promise<Response> => {
        const webhook = bot.webhooks[adapterName];
        const ctx = new ContextContainer();
        ctx.setVirtualContext(ActiveWebhookKey, { from: args.from });
        return contextStorage.run(ctx, () =>
          webhook(request, {
            ...config.webhook,
            waitUntil(task: Promise<unknown>) {
              args.waitUntil(task);
            },
          }),
        );
      };
      return [GET<ChatSdkChannelState>(path, handler), POST<ChatSdkChannelState>(path, handler)];
    }),
    async receive(input, { from }) {
      const thread = serializeReceiveTarget(bot, input.target);
      return from(thread.id).send(input.message, {
        auth: input.auth,
        state: { thread },
      });
    },
    // `session.auth.current` is the caller of this delivery.
    deliver(
      payload,
      channel: ChatSdkChannelContext<TAdapters> & { readonly session: ChannelContext["session"] },
    ) {
      recordPrincipalUser(channel.state, channel.session.auth.current, payload);
      recordLatestMessage(channel.state, payload);
      const answer = resolveInputAnswer(channel.state, payload);
      if (answer !== undefined)
        return { answers: parseAnswers([answer]), context: payload.context };
      return withUndeliveredReplyNote(channel.state, payload, SURFACE_NAME);
    },
    events: mergedEvents,
  });

  return {
    bot,
    channel,
    send(message, options) {
      return bridgeSend(bot, message, options);
    },
    respond(answers, options) {
      return bridgeRespond(bot, answers, options);
    },
  };
}

function defaultEvents<TAdapters extends ChatSdkAdapters>(
  inputActionPrefix: string,
): ChatSdkChannelEvents<TAdapters> {
  type EventChannel = Parameters<
    NonNullable<ChatSdkChannelEvents<TAdapters>["interaction.opened"]>
  >[1]["channel"];

  async function showPrompt(channel: EventChannel, request: Interaction) {
    if (!channel.thread) return false;
    const posted = await channel.thread.post(renderInteractions([request], inputActionPrefix));
    if (!posted.id) return;
    // Tracked even without edit support, so an answer can name the card it is on.
    channel.state.pendingInputCards = {
      ...channel.state.pendingInputCards,
      [posted.id]: { requests: [request], resolved: {} },
    };
  }

  async function clearAnsweredCards(
    event: { readonly resolutions: readonly RequestSettlement[] },
    channel: EventChannel,
  ) {
    const thread = channel.thread;
    if (!thread) return;
    for (const [messageId, card] of Object.entries(channel.state.pendingInputCards ?? {})) {
      const resolutions = event.resolutions.filter((resolution) =>
        card.requests.some((request) => request.interactionId === resolution.interactionId),
      );
      if (resolutions.length === 0) continue;
      const resolved = {
        ...card.resolved,
        ...Object.fromEntries(
          resolutions.map((resolution) => [resolution.interactionId, resolution]),
        ),
      };
      const { [messageId]: _, ...rest } = channel.state.pendingInputCards ?? {};
      channel.state.pendingInputCards = card.requests.every(
        (request) => resolved[request.interactionId] !== undefined,
      )
        ? rest
        : { ...rest, [messageId]: { requests: card.requests, resolved } };
      if (channel.state.editSupported === false) continue;
      try {
        await thread.adapter.editMessage(
          thread.id,
          messageId,
          renderInteractions(card.requests, inputActionPrefix, resolved),
        );
      } catch (error) {
        if (!isNotImplemented(error)) {
          log.warn("answered input card edit failed", { error, messageId });
          continue;
        }
        channel.state.editSupported = false;
      }
    }
  }

  const prompts = promptQueue(showPrompt);
  return {
    async "turn.started"(_event, { channel }) {
      channel.state.pendingToolCallMessage = null;
      clearStream(channel.state);
      await safeStartTyping(channel.thread, "Working...");
    },
    async "call.requested"({ data }, { channel }) {
      const buffered = channel.state.pendingToolCallMessage;
      channel.state.pendingToolCallMessage = null;
      if (buffered) {
        await safeStartTyping(channel.thread, truncate(buffered));
        return;
      }
      // eve's own task controls stay out of view.
      if (data.capability.kind === "control") return;
      const label = callLabel(data);
      await safeStartTyping(channel.thread, truncate(`${label}...`));
    },
    async "content.delta"({ data }, { channel }) {
      if (!channel.thread || !canStream(channel)) return;
      // Only text streams: a part announces its kind with its first delta.
      const streaming = channel.state.streamPartId === data.partId;
      if (data.kind === undefined ? !streaming : data.kind !== "text") return;
      const currentText = streaming ? channel.state.streamText : null;
      const message = (currentText ?? "") + data.delta;
      if (!message) return;
      channel.state.streamText = message;
      const anchor = channel.state.anchorMessageId;
      if (!anchor || !streaming) {
        const sent = await channel.thread.post({ markdown: message });
        channel.state.shownText = message;
        channel.state.anchorMessageId = sent.id;
        channel.state.streamPartId = data.partId;
        channel.state.lastEditAtMs = Date.now();
        return;
      }
      const lastEdit = channel.state.lastEditAtMs ?? 0;
      if (Date.now() - lastEdit < channel.streamingEditIntervalMs) return;
      try {
        await editMessage(channel.thread, anchor, message);
        channel.state.shownText = message;
        channel.state.lastEditAtMs = Date.now();
      } catch (error) {
        if (!isNotImplemented(error)) throw error;
        // Keep the anchor: completion must not post the reply beside it.
        channel.state.editSupported = false;
      }
    },
    // Some adapters show only text, where a reply can answer only the request
    // it sees, so cards post one at a time.
    async "interaction.opened"(event, ctx) {
      const { data } = event;
      const { channel } = ctx;
      const signIns = chatSdkSignIns(channel);
      if (signIns !== undefined)
        await showSignIn(sessionTables(ctx.view), data.interactionId, signIns);
    },
    // Covers every way a request ends: a press, a typed answer, or a withdrawal.
    async "interaction.settled"(event, ctx) {
      const { data } = event;
      const { channel } = ctx;
      const signIns = chatSdkSignIns(channel);
      if (signIns !== undefined) await settleSignIn(sessionTables(ctx.view), data, signIns);
      const resolution = requestSettlementOf(sessionTables(ctx.view), data);
      if (resolution !== undefined)
        await clearAnsweredCards({ resolutions: [resolution] }, channel);
    },
    committed: prompts,
    async "content.completed"({ data }, { channel, session }) {
      if (data.kind !== "text") return;
      const text = typeof data.value === "string" ? data.value : "";
      if (contentPhase(data.phase) === "narration") {
        channel.state.pendingToolCallMessage = text ? (firstNonEmptyLine(text) ?? null) : null;
        // Finalize the streamed anchor so it shows the complete pre-tool-call
        // text rather than the last throttled edit. Pass `false` so nothing new
        // is posted when nothing was streamed — intermediate tool-call narration
        // must not become a standalone message on non-streaming surfaces.
        if (text) {
          try {
            await finalizeStreamedMessage(channel, text, false);
          } catch (error) {
            if (!isNotImplemented(error)) throw error;
          }
        } else {
          clearStream(channel.state);
        }
        return;
      }
      channel.state.pendingToolCallMessage = null;
      if (!text) {
        clearStream(channel.state);
        return;
      }
      try {
        await finalizeStreamedMessage(channel, text, true);
      } catch (error) {
        await reportUndeliveredReply(
          {
            log,
            name: SURFACE_NAME,
            post: async (notice) => channel.thread?.post(notice),
            state: channel.state,
          },
          session.turn.id,
          error,
        );
      }
    },
    async "turn.settled"({ data }, { channel }) {
      const notice = failureNotice(data, "turn");
      if (notice !== undefined) await channel.thread?.post(notice);
    },
    async "session.ended"({ data }, { channel }) {
      const notice = failureNotice(data, { restart: "message" });
      if (notice !== undefined) await channel.thread?.post(notice);
    },
  };
}

/**
 * Posts a typing indicator without failing the turn when the adapter does not
 * support one. Swallows {@link isNotImplemented} errors (e.g. email adapters)
 * and rethrows anything else.
 */
async function safeStartTyping(thread: Thread | null, status?: string): Promise<void> {
  if (!thread) return;
  try {
    await thread.startTyping(status);
  } catch (error) {
    if (!isNotImplemented(error)) throw error;
  }
}

/**
 * Edits a previously posted message in place via the adapter. Rendered as
 * markdown so streamed edits match the completed-message formatting.
 */
async function editMessage(thread: Thread, messageId: string, markdown: string): Promise<void> {
  await thread.adapter.editMessage(thread.id, messageId, { markdown });
}

/**
 * Replaces a pressed request card with only `label`. The session that held the
 * request is gone and a press carries no prompt text, so the prompt can't be
 * kept; what matters is that the buttons stop being offered.
 */
async function retireInputCard(
  thread: Pick<Thread, "adapter" | "id">,
  messageId: string,
  label: string,
): Promise<void> {
  try {
    await thread.adapter.editMessage(thread.id, messageId, renderRetiredInputRequest(label));
  } catch (error) {
    if (!isNotImplemented(error)) throw error;
  }
}

/**
 * Shows a completed assistant message and clears the stream. With a streamed
 * anchor, edits it to the complete text unless it already shows it; the
 * anchor is the reply, so a failed edit throws rather than posting the reply
 * beside it, and an edit {@link isNotImplemented} also disables edits for the
 * session. Without an anchor, posts the message when `postWhenNoAnchor` is
 * `true` (a final reply on a non-streaming surface); when `false`, leaves the
 * surface untouched so intermediate tool-call narration does not become a
 * standalone message.
 */
async function finalizeStreamedMessage(
  channel: ChatSdkChannelContext,
  message: string,
  postWhenNoAnchor: boolean,
): Promise<void> {
  const { anchorMessageId: anchor, shownText } = channel.state;
  clearStream(channel.state);
  const thread = channel.thread;
  if (!thread) return;
  if (!anchor) {
    if (postWhenNoAnchor) await thread.post({ markdown: message });
    return;
  }
  if (shownText === message) return;
  try {
    await editMessage(thread, anchor, message);
  } catch (error) {
    if (isNotImplemented(error)) channel.state.editSupported = false;
    throw error;
  }
}

/** Whether streamed edits are enabled and still supported by the adapter. */
function canStream(channel: ChatSdkChannelContext): boolean {
  return channel.streaming && channel.state.editSupported !== false;
}

/** Resets the streaming anchor so the next step starts a fresh message. */
function clearStream(state: ChatSdkChannelState): void {
  state.anchorMessageId = null;
  state.lastEditAtMs = null;
  state.streamPartId = null;
  state.streamText = null;
  state.shownText = null;
}

/** First non-blank line of `text`, used as a compact typing status. */
function firstNonEmptyLine(text: string): string | undefined {
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

/** Caps `text` at `max` characters with a trailing ellipsis. */
function truncate(text: string, max = MAX_TYPING_STATUS): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}\u2026`;
}

async function bridgeSend<TAdapters extends ChatSdkAdapters>(
  bot: Chat<TAdapters>,
  message: MessageContent,
  options: ChatSdkSendOptions,
): Promise<Delivery> {
  const from = activeFrom("send");
  const { adapterName, auth, inputAnswer, thread: threadInput, ...sendOptions } = options;
  const thread = serializeThread(bot, threadInput, adapterName);
  const state: ChatSdkDeliveryState = { thread };
  if (inputAnswer !== undefined) state.inputAnswer = inputAnswer;
  return from(thread.id).send(message, {
    ...sendOptions,
    auth: auth ?? null,
    state,
  });
}

async function bridgeRespond<TAdapters extends ChatSdkAdapters>(
  bot: Chat<TAdapters>,
  answers: readonly Answer[],
  options: ChatSdkRespondOptions,
): Promise<Delivery> {
  const from = activeFrom("respond");
  const { adapterName, auth, thread: threadInput, ...respondOptions } = options;
  const thread = serializeThread(bot, threadInput, adapterName);
  return from(thread.id).respond(parseAnswers(answers), {
    ...respondOptions,
    auth: auth ?? null,
  });
}

/**
 * Records the author of the delivery's message as the Chat SDK user behind its
 * caller. A principal several people send as, such as tenant auth, names no one
 * person, so it records `null` rather than whoever spoke last.
 */
function recordPrincipalUser(
  state: ChatSdkChannelState,
  caller: SessionAuthContext | null,
  payload: ChannelDelivery<ChatSdkChannelState>,
): void {
  if (caller === null) return;
  const thread = payload.state?.thread;
  const author = thread?.currentMessage?.author;
  if (author === undefined || author.isBot === true || author.isMe) return;
  const recorded = state.usersByPrincipal?.[caller.principalId];
  if (recorded === author.userId || recorded === null) return;
  state.usersByPrincipal = {
    ...state.usersByPrincipal,
    [caller.principalId]: recorded === undefined ? author.userId : null,
  };
}

/**
 * Records the delivery's message as the thread's latest. Session state keeps
 * the thread from the first delivery, so its `currentMessage` goes stale.
 */
function recordLatestMessage(
  state: ChatSdkChannelState,
  payload: ChannelDelivery<ChatSdkChannelState>,
): void {
  const message = payload.state?.thread?.currentMessage;
  if (message === undefined || message.author.isMe) return;
  state.latestMessageId = message.id;
}

/** Channel state a delivery carries. `inputAnswer` lives only on the delivery. */
interface ChatSdkDeliveryState extends ChatSdkChannelState {
  inputAnswer?: ChatSdkInputAnswer;
}

/**
 * The response for a delivery's `inputAnswer`, when its card still waits on a
 * request that offers the option. Matching the card keeps an answer meant for
 * one prompt from settling a different request.
 */
function resolveInputAnswer(
  state: ChatSdkChannelState,
  payload: ChannelDelivery<ChatSdkChannelState>,
): Answer | undefined {
  const answer = (payload.state as Partial<ChatSdkDeliveryState> | undefined)?.inputAnswer;
  if (answer === undefined) return undefined;
  const card = state.pendingInputCards?.[answer.messageId];
  const request = card?.requests.find(
    (candidate) =>
      card.resolved[candidate.interactionId] === undefined &&
      candidate.request.kind !== "sign-in" &&
      candidate.request.options?.some((option) => option.id === answer.optionId) === true,
  );
  return request === undefined
    ? undefined
    : { optionId: answer.optionId, interactionId: request.interactionId };
}

function activeFrom(operation: "respond" | "send"): ChannelFrom<ChatSdkChannelState> {
  const active = contextStorage.getStore()?.get(ActiveWebhookKey);
  if (!active) {
    throw new Error(
      `chatSdkChannel().${operation} can only run during a Chat SDK webhook handler for this bridge.`,
    );
  }
  return active.from;
}

function initialState(): ChatSdkChannelState {
  return { pendingAuthMessageIds: {}, thread: null };
}

/**
 * Downloads an attachment `messageContentOf` deferred to the step: rebuilds
 * the download with the adapter's `rehydrateAttachment`, since the message's
 * own `fetchData` didn't survive the queue.
 */
async function fetchAttachment<TAdapters extends ChatSdkAdapters>(
  bot: Chat<TAdapters>,
  url: string,
): Promise<FetchFileResult | null> {
  const ref = parseChatSdkFileRef(new URL(url));
  if (ref === null) return null;
  // The step may run where the webhook didn't, so the adapters may not be initialized yet.
  await bot.initialize();
  const rehydrated = bot.getAdapter(ref.adapter).rehydrateAttachment?.(ref.attachment);
  if (rehydrated?.fetchData === undefined) {
    throw new EveAttachmentError({
      adapterKind: "chat-sdk",
      kind: "resolver-threw",
      message: `the ${ref.adapter} adapter can't download it after the webhook returns.`,
    });
  }
  let data: Buffer | ArrayBuffer;
  try {
    data = await rehydrated.fetchData();
  } catch (cause) {
    if (cause instanceof EveAttachmentError) throw cause;
    throw new EveAttachmentError({
      adapterKind: "chat-sdk",
      cause,
      kind: "resolver-threw",
      message: `the ${ref.adapter} download failed.`,
    });
  }
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  assertWithinLimit(bytes, DEFAULT_UPLOAD_POLICY.maxBytes, "chat-sdk");
  return { bytes, mediaType: ref.attachment.mimeType };
}

function threadFromState<TAdapters extends ChatSdkAdapters>(
  bot: Chat<TAdapters>,
  state: ChatSdkChannelState,
): Thread | null {
  if (!state.thread) return null;
  try {
    const serialized = state.thread;
    return new ThreadImpl({
      adapter: bot.getAdapter(serialized.adapterName),
      channelId: serialized.channelId,
      channelVisibility: serialized.channelVisibility,
      currentMessage: serialized.currentMessage
        ? Message.fromJSON(serialized.currentMessage)
        : undefined,
      id: serialized.id,
      isDM: serialized.isDM,
      stateAdapter: bot.getState(),
    });
  } catch (error) {
    log.warn("failed to rebuild Chat SDK thread from channel state", { error });
    return null;
  }
}

function serializeReceiveTarget<TAdapters extends ChatSdkAdapters>(
  bot: Chat<TAdapters>,
  target: ChatSdkReceiveTarget,
): SerializedThread {
  if (target.thread) return target.thread;
  if (!target.threadId) {
    throw new Error("chatSdkChannel().receive requires target.thread or target.threadId.");
  }
  return serializeThread(bot, target.threadId, target.adapterName);
}

function serializeThread<TAdapters extends ChatSdkAdapters>(
  bot: Chat<TAdapters>,
  thread: SerializedThread | Thread | string,
  adapterName?: string,
): SerializedThread {
  if (typeof thread === "string") {
    const resolvedAdapterName = adapterName ?? inferAdapterName(thread);
    const adapter = bot.getAdapter(resolvedAdapterName);
    return {
      _type: "chat:Thread",
      adapterName: resolvedAdapterName,
      channelId: adapter.channelIdFromThreadId(thread),
      channelVisibility: adapter.getChannelVisibility?.(thread),
      id: thread,
      isDM: false,
    };
  }
  if (isSerializedThread(thread)) return thread;
  return thread.toJSON();
}

function isSerializedThread(value: SerializedThread | Thread): value is SerializedThread {
  return "_type" in value && value._type === "chat:Thread";
}

function inferAdapterName(threadId: string): string {
  const separator = threadId.indexOf(":");
  if (separator <= 0) {
    throw new Error("chatSdkChannel string thread references require options.adapterName.");
  }
  return threadId.slice(0, separator);
}

function adapterNames<TAdapters extends ChatSdkAdapters>(
  adapters: TAdapters,
): Extract<keyof TAdapters, string>[] {
  return Object.keys(adapters) as Extract<keyof TAdapters, string>[];
}

function routeForAdapter<TAdapters extends ChatSdkAdapters>(
  adapterName: Extract<keyof TAdapters, string>,
  config: ChatSdkChannelConfig<TAdapters>,
): string {
  const override = config.routes?.[adapterName];
  if (override) return override;
  const route = config.route ?? DEFAULT_ROUTE;
  return `${route.replace(/\/$/u, "")}/${adapterName}`;
}
