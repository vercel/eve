import type { SessionAuthContext } from "#channel/types.js";
import {
  chatSdkChannel,
  type ChatSdkChannel,
  type ChatSdkChannelBridge,
  type ChatSdkChannelEvents,
} from "#public/channels/chat-sdk/index.js";
import { createMemoryState } from "#compiled/@chat-adapter/state-memory/index.js";
import type { Message, Thread } from "#compiled/chat/index.js";
import {
  createSendblueAdapter,
  type SendblueAdapter,
  type SendblueAdapterConfig,
} from "#compiled/chat-adapter-sendblue/index.js";
import { sendblueInboundContent } from "#public/channels/sendblue/inboundContent.js";

/** Sendblue credentials used by {@link sendblueChannel}. */
export type SendblueChannelCredentials = Partial<SendblueAdapterConfig>;

/** Context passed to {@link SendblueChannelConfig.onMessage}. */
export interface SendblueInboundMessageContext {
  /** Low-level Chat SDK thread for Sendblue-specific operations. */
  readonly thread: Thread;
}

/** Result of {@link SendblueChannelConfig.onMessage}. Return `null` to drop the message. */
export type SendblueInboundResult = {
  readonly auth: SessionAuthContext | null;
  readonly context?: readonly string[];
} | null;

/** Sync or async {@link SendblueInboundResult}. */
export type SendblueInboundResultOrPromise = SendblueInboundResult | Promise<SendblueInboundResult>;

/** Configuration for {@link sendblueChannel}. */
export interface SendblueChannelConfig {
  /** Sendblue API and webhook credentials. Unspecified values use Sendblue environment variables. */
  readonly credentials?: SendblueChannelCredentials;
  /** Per-event overrides for the underlying Chat SDK channel. */
  readonly events?: ChatSdkChannelEvents<{ sendblue: SendblueAdapter }>;
  /** Inbound message policy. Defaults to dispatching every message with no user auth. */
  readonly onMessage?: (
    ctx: SendblueInboundMessageContext,
    message: Message,
  ) => SendblueInboundResultOrPromise;
  /** Override the default webhook route (`/eve/v1/sendblue`). */
  readonly route?: string;
  /** Messaging services accepted from inbound webhooks. Defaults to iMessage only. */
  readonly allowedServices?: SendblueAdapterConfig["allowedServices"];
  /** Sendblue webhook secret. Defaults to `SENDBLUE_WEBHOOK_SECRET`. */
  readonly webhookSecret?: string;
  /** Display name used by the Chat SDK runtime. Defaults to `"eve"`. */
  readonly userName?: string;
}

/** First-class eve channel backed by Sendblue. */
export interface SendblueChannel extends ChatSdkChannel {}

/**
 * Creates an eve channel for Sendblue iMessage, SMS, and RCS conversations.
 *
 * @example
 * ```ts
 * import { sendblueChannel } from "eve/channels/sendblue";
 *
 * export default sendblueChannel({
 *   allowedServices: ["iMessage", "SMS", "RCS"],
 * });
 * ```
 */
export function sendblueChannel(config: SendblueChannelConfig = {}): SendblueChannel {
  const sendblue = createSendblueAdapter({
    ...config.credentials,
    allowedServices: config.allowedServices ?? config.credentials?.allowedServices,
    webhookSecret: config.webhookSecret ?? config.credentials?.webhookSecret,
  });
  const bridge = chatSdkChannel({
    adapters: { sendblue },
    concurrency: "concurrent",
    events: config.events,
    routes: { sendblue: config.route ?? "/eve/v1/sendblue" },
    state: createMemoryState(),
    streaming: false,
    userName: config.userName ?? "eve",
  });
  const onMessage = config.onMessage ?? defaultOnMessage;

  bridge.bot.onDirectMessage(async (thread: Thread, message: Message) => {
    await dispatchMessage(bridge, onMessage, thread, message);
  });
  bridge.bot.onNewMessage(/[\s\S]*/, async (thread: Thread, message: Message) => {
    await dispatchMessage(bridge, onMessage, thread, message);
  });

  return bridge.channel;
}

async function defaultOnMessage(): Promise<SendblueInboundResult> {
  return { auth: null };
}

async function dispatchMessage(
  bridge: ChatSdkChannelBridge<{ sendblue: SendblueAdapter }>,
  onMessage: NonNullable<SendblueChannelConfig["onMessage"]>,
  thread: Thread,
  message: Message,
): Promise<void> {
  const result = await onMessage({ thread }, message);
  if (result === null) return;
  const content = sendblueInboundContent(message);
  if (content === undefined) return;
  await bridge.send(
    {
      context: [...(result.context ?? [])],
      message: content,
    },
    { auth: result.auth, thread, turnPolicy: "experimental-steer" },
  );
}
