import { vercelOidc } from "#public/channels/auth.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { Channel } from "#public/definitions/channel.js";
import { chatSdkChannel, type ChatSdkChannelBridge } from "#public/channels/chat-sdk/index.js";
import { createMemoryState } from "#compiled/@chat-adapter/state-memory/index.js";
import {
  createSendblueAdapter,
  type SendblueAdapter,
  type SendblueAdapterConfig,
} from "#compiled/chat-adapter-sendblue/index.js";
import type { Message, Thread } from "#compiled/chat/index.js";
import { sendblueInboundContent } from "#public/channels/sendblue/inboundContent.js";

/**
 * Sendblue adapter credentials and line configuration.
 *
 * Pass direct API credentials, or `connectSendblueCredentials(...)` from
 * `@vercel/connect/eve` for a rotating bearer token and managed line.
 */
export type SendblueChannelCredentials = Partial<
  Pick<
    SendblueAdapterConfig,
    | "accessToken"
    | "allowedFromNumbers"
    | "apiKey"
    | "apiSecret"
    | "defaultFromNumber"
    | "webhookSecret"
    | "webhookVerifier"
  >
>;

/** Configuration for {@link sendblueChannel}. */
export interface SendblueChannelConfig {
  /** Direct Sendblue credentials or `connectSendblueCredentials(...)`. */
  readonly credentials: SendblueChannelCredentials;
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
  const sendblue = createSendblueAdapter({
    ...config.credentials,
    ...(config.credentials.webhookSecret || config.credentials.webhookVerifier
      ? {}
      : { webhookVerifier: vercelOidc() }),
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
    { auth: defaultSendblueAuth(message), thread, turnPolicy: "steer" },
  );
}

/** Default Sendblue auth projection for inbound Chat SDK message authors. */
export function defaultSendblueAuth(message: Message): SessionAuthContext {
  const attributes: Record<string, string> = {};
  if (message.author.userName !== undefined) attributes.user_name = message.author.userName;
  return {
    attributes,
    authenticator: "sendblue-message",
    issuer: "sendblue",
    principalId: `sendblue:${message.author.userId}`,
    principalType: message.author.isBot ? "service" : "user",
    subject: message.author.userId,
  };
}

async function markReadBestEffort(adapter: SendblueAdapter, thread: Thread): Promise<void> {
  try {
    await adapter.markRead(thread.id);
  } catch {
    // A read receipt should never prevent the user's message from reaching eve.
  }
}
