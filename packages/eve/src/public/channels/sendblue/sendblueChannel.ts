import type { SessionAuthContext } from "#channel/types.js";
import { vercelOidc } from "#public/channels/auth.js";
import {
  chatSdkChannel,
  type ChatSdkChannel,
  type ChatSdkChannelBridge,
  type ChatSdkChannelEvents,
} from "#public/channels/chat-sdk/index.js";
import { createMemoryState } from "#compiled/@chat-adapter/state-memory/index.js";
import { createSendblueAdapter } from "#compiled/chat-adapter-sendblue/index.js";
import type { Message, Thread } from "#compiled/chat/index.js";
import { sendblueInboundContent } from "#public/channels/sendblue/inboundContent.js";

type SendblueCredentialsProvider = () =>
  | { apiKey: string; apiSecret: string }
  | { accessToken: string }
  | Promise<{ apiKey: string; apiSecret: string } | { accessToken: string }>;
type SendblueWebhookVerifier = (request: Request, rawBody: string) => unknown | Promise<unknown>;
type SendblueAdapter = { markRead(threadId: string): Promise<void> };
type SendblueFromNumber = string | (() => Promise<string>);
type SendblueAdapterFactory = (config: {
  allowedFromNumbers: readonly string[] | (() => Promise<readonly string[]>);
  credentials: SendblueCredentialsProvider;
  defaultFromNumber: SendblueFromNumber;
  webhookSecret?: string;
  webhookVerifier?: SendblueWebhookVerifier;
}) => SendblueAdapter;
const createAdapter = createSendblueAdapter as unknown as SendblueAdapterFactory;

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
  /** Lazy Sendblue credentials, such as `connectSendblueCredentials(...)`. */
  readonly credentials: SendblueCredentialsProvider;
  /** Sendblue line used for outbound messages and accepted inbound webhooks. */
  readonly fromNumber: SendblueFromNumber;
  /** Per-event overrides for the underlying Chat SDK channel. */
  readonly events?: ChatSdkChannelEvents<{ sendblue: SendblueAdapter }>;
  /** Inbound message policy. Defaults to dispatching every Sendblue message with no user auth. */
  readonly onMessage?: (
    ctx: SendblueInboundMessageContext,
    message: Message,
  ) => SendblueInboundResultOrPromise;
  /** Override the default webhook route (`/eve/v1/sendblue`). */
  readonly route?: string;
  /** Sendblue webhook signing secret for direct provider delivery. */
  readonly webhookSecret?: string;
  /** Trusted webhook verifier. Takes precedence over `webhookSecret`. */
  readonly webhookVerifier?: SendblueWebhookVerifier;
  /** Display name used by the Chat SDK runtime. Defaults to `"eve"`. */
  readonly userName?: string;
}

/** First-class eve channel backed by Sendblue iMessage, SMS, and RCS. */
export interface SendblueChannel extends ChatSdkChannel {}

/**
 * Creates an eve channel for Sendblue conversations.
 *
 * @example
 * ```ts
 * import { connectSendblueChannel } from "@vercel/connect/eve";
 * import { sendblueChannel } from "eve/channels/sendblue";
 *
 * export default sendblueChannel({
 *   ...connectSendblueChannel("sendblue/my-agent"),
 * });
 * ```
 */
export function sendblueChannel(config: SendblueChannelConfig): SendblueChannel {
  const webhookSecret = config.webhookSecret ?? process.env.SENDBLUE_WEBHOOK_SECRET;
  const fromNumber = config.fromNumber;
  const sendblue = createAdapter({
    allowedFromNumbers:
      typeof fromNumber === "string" ? [fromNumber] : async () => [await fromNumber()],
    credentials: config.credentials,
    defaultFromNumber: fromNumber,
    ...(config.webhookVerifier
      ? { webhookVerifier: config.webhookVerifier }
      : webhookSecret
        ? { webhookSecret }
        : { webhookVerifier: vercelOidc() }),
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

  // Sendblue marks every inbound message as a mention. A phone conversation is
  // already one durable eve session, so it intentionally has no Chat SDK subscription state.
  bridge.bot.onNewMention(async (thread: Thread, message: Message) => {
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
  await markReadBestEffort(bridge.bot.getAdapter("sendblue"), thread);
  const content = sendblueInboundContent(message);
  if (content === undefined) return;
  await bridge.send(
    { context: [...(result.context ?? [])], message: content },
    { auth: result.auth, thread, turnPolicy: "experimental-steer" },
  );
}

async function markReadBestEffort(adapter: SendblueAdapter, thread: Thread): Promise<void> {
  try {
    await adapter.markRead(thread.id);
  } catch {
    // A read receipt should never prevent the user's message from reaching eve.
  }
}
