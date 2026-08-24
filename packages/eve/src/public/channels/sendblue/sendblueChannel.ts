import { vercelOidc } from "#public/channels/auth.js";
import type { Channel } from "#public/definitions/channel.js";
import { chatSdkChannel, type ChatSdkChannelBridge } from "#public/channels/chat-sdk/index.js";
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

/** Configuration for {@link sendblueChannel}. */
export interface SendblueChannelConfig {
  /** Direct Sendblue credentials or a lazy provider such as `connectSendblueCredentials(...)`. */
  readonly credentials: SendblueChannelCredentials | SendblueChannelCredentialsProvider;
  /** Override the default webhook route (`/eve/v1/sendblue`). */
  readonly route?: string;
  /** Display name used by the Chat SDK runtime. Defaults to `"eve"`. */
  readonly userName?: string;
}

/** First-class eve channel backed by Sendblue iMessage, SMS, and RCS. */
export interface SendblueChannel extends Channel<any, any, any> {}

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
    routes: { sendblue: config.route ?? "/eve/v1/sendblue" },
    state: createMemoryState(),
    streaming: false,
    userName: config.userName ?? "eve",
  });
  // Sendblue marks every inbound message as a mention. A phone conversation is
  // already one durable eve session, so it intentionally has no Chat SDK subscription state.
  bridge.bot.onNewMention(async (thread: Thread, message: Message) => {
    await dispatchMessage(bridge, thread, message);
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

async function dispatchMessage(
  bridge: ChatSdkChannelBridge<{ sendblue: SendblueAdapter }>,
  thread: Thread,
  message: Message,
): Promise<void> {
  await markReadBestEffort(bridge.bot.getAdapter("sendblue"), thread);
  const content = sendblueInboundContent(message);
  if (content === undefined) return;
  await bridge.send(
    { context: [], message: content },
    { auth: null, thread, turnPolicy: "experimental-steer" },
  );
}

async function markReadBestEffort(adapter: SendblueAdapter, thread: Thread): Promise<void> {
  try {
    await adapter.markRead(thread.id);
  } catch {
    // A read receipt should never prevent the user's message from reaching eve.
  }
}
