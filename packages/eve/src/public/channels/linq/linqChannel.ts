import type { SessionAuthContext, TurnPolicy } from "#channel/types.js";
import { vercelOidc } from "#public/channels/auth.js";
import {
  chatSdkChannel,
  type ChatSdkChannel,
  type ChatSdkChannelBridge,
  type ChatSdkChannelEvents,
} from "#public/channels/chat-sdk/index.js";
import { createMemoryState } from "#compiled/@chat-adapter/state-memory/index.js";
import {
  createLinqAdapter,
  type LinqCredentialProvider,
  type LinqWebhookVerifier,
} from "#compiled/@linqapp/chat-sdk-adapter/index.js";
import type { Message, Thread } from "#compiled/chat/index.js";
import { linqInboundContent } from "#public/channels/linq/inboundContent.js";

/** Context passed to {@link LinqChannelConfig.onMessage}. */
export interface LinqInboundMessageContext {
  /** Low-level Chat SDK thread for Linq-specific operations. */
  readonly thread: Thread;
}

/** Result of {@link LinqChannelConfig.onMessage}. Return `null` to drop the message. */
export type LinqInboundResult = {
  readonly auth: SessionAuthContext | null;
  readonly context?: readonly string[];
  /** Overrides the workflow run title without changing the message sent to the model. */
  readonly title?: string;
} | null;

/** Sync or async {@link LinqInboundResult}. */
export type LinqInboundResultOrPromise = LinqInboundResult | Promise<LinqInboundResult>;

/** A direct value or lazy resolver for a Linq credential. */
export type LinqCredentialValue = string | (() => string | Promise<string>);

/** Linq credentials for outbound API calls and inbound webhook verification. */
export interface LinqChannelCredentials {
  /** API key for outbound Linq API calls. */
  readonly apiKey?: LinqCredentialValue;
  /** Signing secret for direct Linq webhook delivery. */
  readonly signingSecret?: LinqCredentialValue;
  /** Trusted verifier for webhooks forwarded by a provider such as Vercel Connect. */
  readonly webhookVerifier?: LinqWebhookVerifier;
}

/** Configuration for {@link linqChannel}. */
export interface LinqChannelConfig {
  /** Optional Linq API base URL, for example a sandbox endpoint. */
  readonly baseURL?: string;
  /** Outbound credentials and inbound webhook verification. */
  readonly credentials?: LinqChannelCredentials;
  /** Per-event overrides for the underlying Chat SDK channel. */
  readonly events?: ChatSdkChannelEvents<{ linq: ReturnType<typeof createLinqAdapter> }>;
  /** Inbound message policy. Defaults to dispatching every message with no user auth. */
  readonly onMessage?: (
    ctx: LinqInboundMessageContext,
    message: Message,
  ) => LinqInboundResultOrPromise;
  /** Override the default webhook route (`/eve/v1/linq`). */
  readonly route?: string;
  /** Policy for accepted messages that arrive while a turn is active. */
  readonly turnPolicy?: TurnPolicy;
  /** Display name used by the Chat SDK runtime. Defaults to `"eve"`. */
  readonly userName?: string;
}

/** First-class eve channel backed by Linq iMessage and SMS. */
export interface LinqChannel extends ChatSdkChannel {}

/**
 * Creates an eve channel for Linq-powered iMessage and SMS conversations.
 *
 * @example
 * ```ts
 * import { connectLinqCredentials } from "@vercel/connect/eve";
 * import { linqChannel } from "eve/channels/linq";
 *
 * export default linqChannel({
 *   credentials: connectLinqCredentials("linq/my-agent"),
 * });
 * ```
 */
export function linqChannel(config: LinqChannelConfig): LinqChannel {
  const credentials = normalizeCredentials(config.credentials);
  const linq = createLinqAdapter({
    ...(config.baseURL === undefined ? {} : { baseURL: config.baseURL }),
    ...(credentials.provider === undefined ? {} : { credentials: credentials.provider }),
    ...(credentials.webhookVerifier !== undefined
      ? { webhookVerifier: credentials.webhookVerifier }
      : credentials.signingSecret === undefined
        ? { webhookVerifier: vercelOidc() }
        : typeof credentials.signingSecret === "string"
          ? { signingSecret: credentials.signingSecret }
          : {}),
  });
  const bridge = chatSdkChannel({
    adapters: { linq },
    concurrency: "concurrent",
    events: config.events,
    routes: { linq: config.route ?? "/eve/v1/linq" },
    state: createMemoryState(),
    streaming: false,
    turnPolicy: config.turnPolicy,
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

function normalizeCredentials(credentials: LinqChannelConfig["credentials"]): {
  readonly provider?: LinqCredentialProvider;
  readonly signingSecret?: LinqCredentialValue;
  readonly webhookVerifier?: LinqWebhookVerifier;
} {
  if (credentials === undefined) return {};
  const { apiKey, signingSecret, webhookVerifier } = credentials;
  return {
    ...(apiKey === undefined
      ? {}
      : {
          provider: async () => ({
            apiKey: typeof apiKey === "function" ? await apiKey() : apiKey,
            ...(signingSecret === undefined
              ? {}
              : {
                  signingSecret:
                    typeof signingSecret === "function" ? await signingSecret() : signingSecret,
                }),
          }),
        }),
    ...(signingSecret === undefined ? {} : { signingSecret }),
    ...(webhookVerifier === undefined ? {} : { webhookVerifier }),
  };
}

async function defaultOnMessage(): Promise<LinqInboundResult> {
  return { auth: null };
}

async function dispatchMessage(
  bridge: ChatSdkChannelBridge<{ linq: ReturnType<typeof createLinqAdapter> }>,
  onMessage: NonNullable<LinqChannelConfig["onMessage"]>,
  thread: Thread,
  message: Message,
): Promise<void> {
  const result = await onMessage({ thread }, message);
  if (result === null) return;
  await markReadBestEffort(bridge.bot.getAdapter("linq"), thread, message);
  const content = linqInboundContent(message);
  if (content === undefined) return;
  await bridge.send(
    { context: [...(result.context ?? [])], message: content },
    { auth: result.auth, thread, title: result.title },
  );
}

async function markReadBestEffort(
  adapter: ReturnType<typeof createLinqAdapter>,
  thread: Thread,
  message: Message,
): Promise<void> {
  try {
    await adapter.markRead(thread.id, message.id);
  } catch {
    // A read receipt should never prevent the user's message from reaching eve.
  }
}
