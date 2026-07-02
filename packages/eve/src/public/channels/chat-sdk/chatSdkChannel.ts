import type { SessionAuthContext } from "#channel/types.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import { createLogger, extractErrorId, formatErrorHint } from "#internal/logging.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import type { InputRequest } from "#runtime/input/types.js";
import type {
  ActionEvent,
  Adapter,
  CardChild,
  ChatConfig,
  SerializedThread,
  Thread,
  WebhookOptions,
} from "#compiled/chat/index.js";
import {
  Actions,
  Button,
  Card,
  CardText,
  Chat,
  Message,
  ThreadImpl,
} from "#compiled/chat/index.js";
import {
  defineChannel,
  POST,
  type Channel,
  type ChannelEvents,
  type ChannelSessionOps,
  type SendFn,
  type SendOptions,
  type Session,
} from "#public/definitions/defineChannel.js";

const log = createLogger("chat-sdk.channel");
const DEFAULT_ROUTE = "/eve/v1/chat";
const DEFAULT_INPUT_ACTION_PREFIX = "eve_input:";

type ChatSdkAdapters = Record<string, Adapter>;
type ChatSdkSendInput = Parameters<SendFn<ChatSdkChannelState>>[0];
type EventData<T extends HandleMessageStreamEvent["type"]> =
  Extract<HandleMessageStreamEvent, { type: T }> extends { data: infer D } ? D : undefined;

interface ActiveWebhookContext {
  readonly send: SendFn<ChatSdkChannelState>;
}

const ActiveWebhookKey = new ContextKey<ActiveWebhookContext>("chat-sdk.active-webhook");

/**
 * Durable channel state used by `chatSdkChannel`. Stores the last Chat SDK
 * thread for the Eve session so event handlers can post replies without
 * depending on hidden Chat SDK subscription state.
 */
export interface ChatSdkChannelState extends Record<string, unknown> {
  thread: SerializedThread | null;
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
 * Channel-owned metadata exposed to Eve instrumentation.
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
}

/** Event-handler context for `chatSdkChannel`, including Eve session helpers. */
export interface ChatSdkEventContext<TAdapters extends ChatSdkAdapters = ChatSdkAdapters>
  extends ChatSdkChannelContext<TAdapters>, ChannelSessionOps {}

/**
 * Per-event handlers for `chatSdkChannel({ events })`. Each supplied handler
 * replaces the built-in default for that event.
 */
export type ChatSdkChannelEvents<TAdapters extends ChatSdkAdapters = ChatSdkAdapters> =
  ChannelEvents<ChatSdkChannelContext<TAdapters>>;

/**
 * Options for `bridge.send(...)` inside Chat SDK handlers. The `thread`
 * determines the Eve continuation token and the persisted channel state.
 */
export interface ChatSdkSendOptions {
  readonly auth?: SessionAuthContext | null;
  readonly callback?: SendOptions<ChatSdkChannelState>["callback"];
  readonly mode?: SendOptions<ChatSdkChannelState>["mode"];
  readonly thread: SerializedThread | Thread | string;
  readonly title?: string;
  /**
   * Required when `thread` is a string that does not include the Chat SDK
   * adapter prefix. Prefer passing the `Thread` object from the Chat SDK handler
   * when possible.
   */
  readonly adapterName?: string;
}

/**
 * Configuration for {@link chatSdkChannel}. It accepts normal Chat SDK
 * `ChatConfig` fields, plus Eve route and event settings.
 */
export interface ChatSdkChannelConfig<
  TAdapters extends ChatSdkAdapters = ChatSdkAdapters,
> extends Omit<ChatConfig<TAdapters>, "adapters"> {
  /** Map of Chat SDK adapter name to adapter instance. */
  readonly adapters: TAdapters;
  /**
   * Base route for generated adapter webhooks. Defaults to `/eve/v1/chat`, so
   * an adapter named `slack` mounts at `/eve/v1/chat/slack`.
   */
  readonly route?: string;
  /**
   * Per-adapter route overrides. Use when a provider requires a fixed webhook
   * URL or when migrating an existing endpoint without changing provider
   * settings.
   */
  readonly routes?: Partial<Record<Extract<keyof TAdapters, string>, string>>;
  /** Extra Chat SDK webhook options. Eve owns `waitUntil`. */
  readonly webhook?: Omit<WebhookOptions, "waitUntil">;
  /** Optional Eve event handlers. Supplied handlers replace built-in defaults. */
  readonly events?: ChatSdkChannelEvents<TAdapters>;
  /**
   * Prefix for default Eve HITL button action ids. Change this if your Chat SDK
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
 * from those handlers to hand work to Eve.
 */
export interface ChatSdkChannelBridge<TAdapters extends ChatSdkAdapters = ChatSdkAdapters> {
  readonly bot: Chat<TAdapters>;
  readonly channel: ChatSdkChannel;
  /**
   * Starts or resumes an Eve session from inside a Chat SDK webhook handler.
   * Use `channel.receive(...)` for proactive sends that are not handling an
   * inbound Chat SDK webhook.
   */
  send(input: ChatSdkSendInput, options: ChatSdkSendOptions): Promise<Session>;
}

/**
 * Creates an Eve channel backed by one Chat SDK runtime and its adapters.
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
  const mergedEvents: ChatSdkChannelEvents<TAdapters> = {
    ...defaultEvents<TAdapters>(inputActionPrefix),
    ...config.events,
  };

  bot.onAction(async (event: ActionEvent) => {
    const response = decodeInputAction(event.actionId, inputActionPrefix, event.value);
    if (!response) return;
    if (!event.thread) {
      throw new Error(
        "chatSdkChannel input actions require a thread on the Chat SDK action event.",
      );
    }
    await bridgeSend(
      bot,
      { inputResponses: [response] },
      {
        auth: config.resolveInputAuth ? await config.resolveInputAuth(event) : null,
        thread: event.thread,
      },
    );
  });

  const channel = defineChannel<
    ChatSdkChannelState,
    ChatSdkChannelContext<TAdapters>,
    ChatSdkReceiveTarget,
    ChatSdkInstrumentationMetadata
  >({
    kindHint: "chat-sdk",
    state: initialState(),
    metadata: metadataFromState,
    context(state) {
      return {
        bot,
        state,
        thread: threadFromState(bot, state),
      };
    },
    routes: adapterNames(config.adapters).map((adapterName) =>
      POST<ChatSdkChannelState>(routeForAdapter(adapterName, config), async (request, args) => {
        const webhook = bot.webhooks[adapterName];
        const ctx = new ContextContainer();
        ctx.setVirtualContext(ActiveWebhookKey, { send: args.send });
        return contextStorage.run(ctx, () =>
          webhook(request, {
            ...config.webhook,
            waitUntil(task: Promise<unknown>) {
              args.waitUntil(task);
            },
          }),
        );
      }),
    ),
    async receive(input, { send }) {
      const thread = serializeReceiveTarget(bot, input.target);
      return send(input.message, {
        auth: input.auth,
        continuationToken: thread.id,
        state: { thread },
      });
    },
    events: mergedEvents,
  });

  return {
    bot,
    channel,
    send(input, options) {
      return bridgeSend(bot, input, options);
    },
  };
}

function defaultEvents<TAdapters extends ChatSdkAdapters>(
  inputActionPrefix: string,
): ChatSdkChannelEvents<TAdapters> {
  return {
    async "turn.started"(_event, channel, _ctx) {
      await channel.thread?.startTyping("Working...");
    },
    async "input.requested"(event, channel, _ctx) {
      if (!channel.thread || event.requests.length === 0) return;
      await channel.thread.post(renderInputRequests(event.requests, inputActionPrefix));
    },
    async "message.completed"(event, channel, _ctx) {
      if (event.finishReason === "tool-calls" || !event.message || !channel.thread) return;
      await channel.thread.post(event.message);
    },
    async "turn.failed"(event, channel, _ctx) {
      await postFailure(channel.thread, "I hit an error while handling your request", event);
    },
    async "session.failed"(event, channel) {
      await postFailure(channel.thread, "This session could not recover from an error", event);
    },
  };
}

function renderInputRequests(requests: readonly InputRequest[], inputActionPrefix: string) {
  return Card({
    children: requests.flatMap((request) => renderInputRequest(request, inputActionPrefix)),
  });
}

function renderInputRequest(request: InputRequest, inputActionPrefix: string) {
  const children: CardChild[] = [CardText(request.prompt)];
  if (request.options && request.options.length > 0) {
    children.push(
      Actions(
        request.options.map((option) =>
          Button({
            id: encodeInputAction(inputActionPrefix, request.requestId, option.id),
            label: option.label,
            style: option.style,
            value: option.id,
          }),
        ),
      ),
    );
    return children;
  }
  children.push(
    CardText("This request needs a freeform answer. Continue from the Eve session UI."),
  );
  return children;
}

async function postFailure(
  thread: Thread | null,
  prefix: string,
  event: EventData<"turn.failed"> | EventData<"session.failed">,
): Promise<void> {
  if (!thread) return;
  const hint = formatErrorHint(event);
  const errorId = extractErrorId(event.details);
  await thread.post(
    [
      `${prefix}${hint}.`,
      "Please try again, rephrase, or reach out if it keeps failing.",
      ...(errorId ? [`Error id: ${errorId}`] : []),
    ].join("\n\n"),
  );
}

async function bridgeSend<TAdapters extends ChatSdkAdapters>(
  bot: Chat<TAdapters>,
  input: ChatSdkSendInput,
  options: ChatSdkSendOptions,
): Promise<Session> {
  const active = contextStorage.getStore()?.get(ActiveWebhookKey);
  if (!active) {
    throw new Error(
      "chatSdkChannel().send can only run during a Chat SDK webhook handler for this bridge.",
    );
  }
  const thread = serializeThread(bot, options.thread, options.adapterName);
  const sendOptions: SendOptions<ChatSdkChannelState> = {
    auth: options.auth ?? null,
    continuationToken: thread.id,
    state: { thread },
  };
  if (options.callback) {
    sendOptions.callback = options.callback;
  }
  if (options.mode) {
    sendOptions.mode = options.mode;
  }
  if (options.title) {
    sendOptions.title = options.title;
  }
  return active.send(input, sendOptions);
}

function initialState(): ChatSdkChannelState {
  return { thread: null };
}

function metadataFromState(state: ChatSdkChannelState): ChatSdkInstrumentationMetadata {
  return {
    adapterName: state.thread?.adapterName ?? null,
    channelId: state.thread?.channelId ?? null,
    isDM: state.thread?.isDM ?? null,
    threadId: state.thread?.id ?? null,
  };
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

function encodeInputAction(prefix: string, requestId: string, optionId: string): string {
  return `${prefix}${encodeURIComponent(requestId)}:${encodeURIComponent(optionId)}`;
}

function decodeInputAction(
  actionId: string,
  prefix: string,
  value: string | undefined,
): { optionId: string; requestId: string } | null {
  if (!actionId.startsWith(prefix)) return null;
  const encoded = actionId.slice(prefix.length);
  const separator = encoded.indexOf(":");
  if (separator <= 0) return null;
  try {
    const requestId = decodeURIComponent(encoded.slice(0, separator));
    const optionId = value ?? decodeURIComponent(encoded.slice(separator + 1));
    return { optionId, requestId };
  } catch {
    return null;
  }
}
