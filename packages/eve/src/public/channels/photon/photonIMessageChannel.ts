import type { SessionAuthContext } from "#channel/types.js";
import { vercelOidc } from "#public/channels/auth.js";
import {
  chatSdkChannel,
  type ChatSdkChannel,
  type ChatSdkChannelBridge,
  type ChatSdkChannelEvents,
} from "#public/channels/chat-sdk/index.js";
import type { Message, Thread } from "#compiled/chat/index.js";
import { createMemoryState } from "#compiled/@chat-adapter/state-memory/index.js";
import {
  createiMessageAdapter,
  type iMessageAdapter,
  type iMessageCredentialProvider,
  type iMessageWebhookVerifier,
} from "#compiled/@photon-ai/chat-adapter-imessage/index.js";
import { photonInboundContent } from "#public/channels/photon/inboundContent.js";

/** Photon project credentials used by {@link photonIMessageChannel}. */
export type PhotonIMessageChannelCredentials = iMessageCredentialProvider;

/** Context passed to {@link PhotonIMessageChannelConfig.onMessage}. */
export interface PhotonInboundMessageContext {
  /** Low-level Chat SDK thread for iMessage-specific operations. */
  readonly thread: Thread;
}

/** Result of {@link PhotonIMessageChannelConfig.onMessage}. Return `null` to drop the message. */
export type PhotonInboundResult = {
  readonly auth: SessionAuthContext | null;
  readonly context?: readonly string[];
} | null;

/** Sync or async {@link PhotonInboundResult}. */
export type PhotonInboundResultOrPromise = PhotonInboundResult | Promise<PhotonInboundResult>;

/** Configuration for {@link photonIMessageChannel}. */
export interface PhotonIMessageChannelConfig {
  /** Lazy Photon project credentials, such as `connectPhotonCredentials(...)`. */
  readonly credentials: PhotonIMessageChannelCredentials;
  /** Per-event overrides for the underlying Chat SDK channel. */
  readonly events?: ChatSdkChannelEvents<{ imessage: iMessageAdapter }>;
  /** Inbound message policy. Defaults to dispatching every message with no user auth. */
  readonly onMessage?: (
    ctx: PhotonInboundMessageContext,
    message: Message,
  ) => PhotonInboundResultOrPromise;
  /** Override the default webhook route (`/eve/v1/photon`). */
  readonly route?: string;
  /** Display name used by the Chat SDK runtime. Defaults to `"eve"`. */
  readonly userName?: string;
  /** Photon webhook signing secret. Falls back to `IMESSAGE_WEBHOOK_SECRET`. */
  readonly webhookSecret?: string;
  /** Trusted webhook verifier. Takes precedence over `webhookSecret`. */
  readonly webhookVerifier?: iMessageWebhookVerifier;
}

/** First-class eve channel backed by Photon iMessage. */
export interface PhotonIMessageChannel extends ChatSdkChannel {}

/**
 * Creates an eve channel for Photon-powered iMessage.
 *
 * @example
 * ```ts
 * import { connectPhotonCredentials } from "@vercel/connect/eve";
 * import { photonIMessageChannel } from "eve/channels/photon";
 *
 * export default photonIMessageChannel({
 *   credentials: connectPhotonCredentials("photon/my-agent"),
 * });
 * ```
 */
export function photonIMessageChannel(config: PhotonIMessageChannelConfig): PhotonIMessageChannel {
  const webhookSecret = config.webhookSecret ?? process.env.IMESSAGE_WEBHOOK_SECRET;
  const imessage = createiMessageAdapter({
    credentials: config.credentials,
    ...(config.webhookVerifier
      ? { webhookVerifier: config.webhookVerifier }
      : webhookSecret
        ? { webhookSecret }
        : { webhookVerifier: vercelOidc() }),
  });
  const bridge = chatSdkChannel({
    adapters: { imessage },
    concurrency: "queue",
    events: config.events,
    routes: { imessage: config.route ?? "/eve/v1/photon" },
    state: createMemoryState(),
    streaming: false,
    userName: config.userName ?? "eve",
  });
  const onMessage = config.onMessage ?? defaultOnMessage;

  bridge.bot.onNewMention(async (thread: Thread, message: Message) => {
    await dispatchMessage(bridge, onMessage, thread, message, true);
  });
  bridge.bot.onSubscribedMessage(async (thread: Thread, message: Message) => {
    await dispatchMessage(bridge, onMessage, thread, message, false);
  });

  return bridge.channel;
}

async function defaultOnMessage(): Promise<PhotonInboundResult> {
  return { auth: null };
}

async function dispatchMessage(
  bridge: ChatSdkChannelBridge<{ imessage: iMessageAdapter }>,
  onMessage: NonNullable<PhotonIMessageChannelConfig["onMessage"]>,
  thread: Thread,
  message: Message,
  subscribe: boolean,
): Promise<void> {
  const result = await onMessage({ thread }, message);
  if (result === null) return;
  await markReadBestEffort(bridge.bot.getAdapter("imessage"), thread, message);
  const content = photonInboundContent(message);
  if (content === undefined) return;
  if (subscribe) await thread.subscribe();
  await bridge.send(
    {
      context: [...(result.context ?? [])],
      message: content,
    },
    { auth: result.auth, thread },
  );
}

async function markReadBestEffort(
  adapter: iMessageAdapter,
  thread: Thread,
  message: Message,
): Promise<void> {
  try {
    await adapter.markRead(thread.id, message.id);
  } catch {
    // A read receipt should never prevent the user's message from reaching eve.
  }
}
