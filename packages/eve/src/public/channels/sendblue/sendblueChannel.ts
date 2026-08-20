import type { SessionAuthContext } from "#channel/types.js";
import { vercelOidc } from "#public/channels/auth.js";
import {
  chatSdkChannel,
  type ChatSdkChannel,
  type ChatSdkChannelBridge,
  type ChatSdkChannelEvents,
} from "#public/channels/chat-sdk/index.js";
import { createMemoryState } from "#compiled/@chat-adapter/state-memory/index.js";
import {
  createSendblueAdapter,
  type SendblueAdapter,
  type SendblueCredentials,
  type SendblueWebhookVerifier,
} from "#compiled/chat-adapter-sendblue/index.js";
import type { Message, Thread } from "#compiled/chat/index.js";
import { sendblueInboundContent } from "#public/channels/sendblue/inboundContent.js";

/** Credentials and webhook settings for a Sendblue channel. */
export type SendblueChannelCredentials = SendblueCredentials & {
  /** Sendblue line used for outbound messages and accepted inbound webhooks. */
  readonly fromNumber: string;
  /** Sendblue webhook signing secret for direct provider delivery. */
  readonly webhookSecret?: string;
  /** Trusted verifier for webhook delivery, such as Vercel Connect's OIDC verifier. */
  readonly webhookVerifier?: SendblueWebhookVerifier;
};

/** Resolves Sendblue credentials for integrations that rotate them. */
export type SendblueChannelCredentialsProvider = () =>
  | SendblueChannelCredentials
  | Promise<SendblueChannelCredentials>;

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
  /** Direct Sendblue credentials or a lazy provider such as `connectSendblueCredentials(...)`. */
  readonly credentials: SendblueChannelCredentials | SendblueChannelCredentialsProvider;
  /** Per-event overrides for the underlying Chat SDK channel. */
  readonly events?: ChatSdkChannelEvents<{ sendblue: SendblueAdapter }>;
  /** Inbound message policy. Defaults to dispatching every Sendblue message with no user auth. */
  readonly onMessage?: (
    ctx: SendblueInboundMessageContext,
    message: Message,
  ) => SendblueInboundResultOrPromise;
  /** Override the default webhook route (`/eve/v1/sendblue`). */
  readonly route?: string;
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
 * import { connectSendblueCredentials } from "@vercel/connect/eve";
 * import { sendblueChannel } from "eve/channels/sendblue";
 *
 * export default sendblueChannel({
 *   credentials: connectSendblueCredentials("sendblue/my-agent"),
 * });
 * ```
 */
export function sendblueChannel(config: SendblueChannelConfig): SendblueChannel {
  const credentials = toCredentialsProvider(config.credentials);
  const webhookSecret =
    (typeof config.credentials === "function" ? undefined : config.credentials.webhookSecret) ??
    process.env.SENDBLUE_WEBHOOK_SECRET;
  const fallbackWebhookVerifier = webhookSecret === undefined ? vercelOidc() : undefined;
  const sendblue = createSendblueAdapter({
    credentials: () => resolveAdapterCredentials(credentials),
    defaultFromNumber: () => resolveFromNumber(credentials),
    ...(webhookSecret
      ? { webhookSecret }
      : {
          webhookVerifier: createCredentialWebhookVerifier(credentials, fallbackWebhookVerifier!),
        }),
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

function toCredentialsProvider(
  credentials: SendblueChannelConfig["credentials"],
): SendblueChannelCredentialsProvider {
  return typeof credentials === "function" ? credentials : () => credentials;
}

async function resolveAdapterCredentials(
  credentials: SendblueChannelCredentialsProvider,
): Promise<SendblueCredentials> {
  const {
    fromNumber: _fromNumber,
    webhookSecret: _webhookSecret,
    webhookVerifier: _webhookVerifier,
    ...adapterCredentials
  } = await credentials();
  return adapterCredentials;
}

async function resolveFromNumber(credentials: SendblueChannelCredentialsProvider): Promise<string> {
  return (await credentials()).fromNumber;
}

function createCredentialWebhookVerifier(
  credentials: SendblueChannelCredentialsProvider,
  fallbackVerifier: SendblueWebhookVerifier,
): SendblueWebhookVerifier {
  return async (request: Request, rawBody: string) => {
    const verifier = (await credentials()).webhookVerifier ?? fallbackVerifier;
    return verifier(request, rawBody);
  };
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
