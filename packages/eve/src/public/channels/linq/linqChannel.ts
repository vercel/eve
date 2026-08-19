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

/** Linq credentials resolved by an external provider, such as Vercel Connect. */
export interface LinqManagedCredentials {
  /** Lazy provider for the Linq API key. */
  readonly credentials: LinqCredentialProvider;
  /** Trusted webhook verifier for provider-forwarded webhooks. */
  readonly webhookVerifier?: LinqWebhookVerifier;
}

/** Direct or externally managed Linq credential provider. */
export type LinqChannelCredentials = LinqCredentialProvider | LinqManagedCredentials;

/** Configuration for {@link linqChannel}. */
export interface LinqChannelConfig {
  /** Direct Linq API key. Prefer `credentials` for managed Connect credentials. */
  readonly apiKey?: string;
  /** Optional Linq API base URL, for example a sandbox endpoint. */
  readonly baseURL?: string;
  /** Lazy Linq API-key provider, such as `connectLinqCredentials(...)`. */
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
  /** Linq webhook signing secret for direct provider delivery. */
  readonly signingSecret?: string;
  /** Trusted webhook verifier. Takes precedence over `signingSecret`. */
  readonly webhookVerifier?: LinqWebhookVerifier;
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
    ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
    ...(config.baseURL === undefined ? {} : { baseURL: config.baseURL }),
    ...(credentials.provider === undefined ? {} : { credentials: credentials.provider }),
    ...(config.webhookVerifier !== undefined
      ? { webhookVerifier: config.webhookVerifier }
      : credentials.webhookVerifier !== undefined
        ? { webhookVerifier: credentials.webhookVerifier }
        : config.signingSecret === undefined
          ? { webhookVerifier: vercelOidc() }
          : { signingSecret: config.signingSecret }),
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
  readonly webhookVerifier?: LinqWebhookVerifier;
} {
  if (credentials === undefined) return {};
  return typeof credentials === "function"
    ? { provider: credentials }
    : {
        provider: credentials.credentials,
        webhookVerifier: credentials.webhookVerifier,
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
