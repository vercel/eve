import type { DiscordInstrumentationMetadata } from "#public/channels/discord/index.js";
import type { SessionHandle } from "#channel/session.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { SessionContext } from "#public/definitions/callback-context.js";
import type { ChannelSessionOps } from "#public/definitions/channel.js";

import { createLogger, logError } from "#internal/logging.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import {
  callDiscordApi,
  createDiscordFollowupMessage,
  discordContinuationToken,
  editDiscordOriginalResponse,
  resolveDiscordBotToken,
  sendDiscordChannelMessage,
  splitDiscordMessageContent,
  triggerDiscordTypingIndicator,
  type DiscordApiOptions,
  type DiscordApiResponse,
  type DiscordCredentials,
  type DiscordMessageBody,
  type DiscordPostedMessage,
} from "#public/channels/discord/api.js";
import { defaultEvents, defaultOnCommand } from "#public/channels/discord/defaults.js";
import {
  deriveComponentInputResponses,
  deriveModalInputResponses,
  buildFreeformModalResponse,
  isDiscordFreeformComponent,
} from "#public/channels/discord/hitl.js";
import {
  commandInteractionMessage,
  DISCORD_INTERACTION_RESPONSE_TYPE,
  DISCORD_INTERACTION_TYPE,
  formatDiscordContextBlock,
  parseDiscordInteraction,
  type DiscordCommandInteraction,
  type DiscordComponentInteraction,
  type DiscordInteraction,
  type DiscordModalSubmitInteraction,
} from "#public/channels/discord/inbound.js";
import {
  discordDeferredJson,
  discordJson,
  discordJsonBody,
  readMessageContent,
} from "#public/channels/discord/responses.js";
import { type DiscordWebhookVerifier } from "#public/channels/discord/verify.js";
import { verifyDiscordInbound } from "#public/channels/discord/verifyInbound.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";
import { defineChannel, POST, type Channel, type SendFn } from "#public/definitions/channel.js";

const log = createLogger("discord.channel");

type EventData<T extends HandleMessageStreamEvent["type"]> =
  Extract<HandleMessageStreamEvent, { type: T }> extends { data: infer D } ? D : undefined;

/** Pre-dispatch Discord context passed to inbound command hooks. */
export interface DiscordContext {
  readonly discord: DiscordHandle;
}

/** Channel-owned Discord context returned by `context()`. */
export type DiscordChannelContext = DiscordContext & { state: DiscordChannelState };

/** Event-handler Discord context, including session operations. */
export interface DiscordEventContext extends DiscordChannelContext, ChannelSessionOps {}

/** JSON-serializable Discord channel state. */
export interface DiscordChannelState {
  /** Discord channel id. */
  channelId: string | null;
  /** Discord message id once anchored, or an interaction placeholder before the first reply. */
  conversationId: string | null;
  /** Discord guild id, when the interaction was invoked in a guild. */
  guildId: string | null;
  /** Discord application id from the inbound interaction. */
  applicationId: string | null;
  /** Latest interaction token available to the channel. */
  interactionToken: string | null;
  /** Whether the channel has already edited the deferred original interaction response. */
  initialResponseSent: boolean;
  /** Whether `conversationId` is a real Discord message id. */
  hasMessageAnchor: boolean;
}

/** Discord channel credentials. */
export interface DiscordChannelCredentials extends DiscordCredentials {
  /** Custom inbound webhook verifier. When supplied, eve skips the `DISCORD_PUBLIC_KEY` fallback and delegates verification to it. */
  readonly webhookVerifier?: DiscordWebhookVerifier;
}

/** Target accepted by `receive(discord, { target })` for proactive sessions. */
export interface DiscordReceiveTarget {
  readonly channelId: string;
  readonly conversationId?: string;
  readonly initialMessage?: string | DiscordMessageBody;
}

/**
 * Result of an inbound Discord command hook. Return `null` to acknowledge the
 * interaction without dispatching the agent.
 * - `auth`: session auth context for the dispatched turn, or `null` for anonymous.
 * - `ephemeral`: when `true`, the deferred reply is visible only to the invoking user.
 * - `context`: model-visible context lines appended after the Discord context block.
 */
export type DiscordCommandResult = {
  readonly auth: SessionAuthContext | null;
  readonly ephemeral?: boolean;
  readonly context?: readonly string[];
} | null;

/** Sync or async {@link DiscordCommandResult}. */
export type DiscordCommandResultOrPromise = DiscordCommandResult | Promise<DiscordCommandResult>;

type DiscordEventHandler<T extends HandleMessageStreamEvent["type"]> = (
  data: EventData<T>,
  channel: DiscordEventContext,
  ctx: SessionContext,
) => void | Promise<void>;

type DiscordSessionFailedHandler = (
  data: EventData<"session.failed">,
  channel: DiscordEventContext,
) => void | Promise<void>;

/** Per-event handlers for `discordChannel({ events })`. Supplied handlers override built-in defaults per key; unspecified events keep their defaults. `session.failed` receives only `(data, channel)`; every other handler also gets the session `ctx`. */
export interface DiscordChannelEvents {
  readonly "turn.started"?: DiscordEventHandler<"turn.started">;
  readonly "actions.requested"?: DiscordEventHandler<"actions.requested">;
  readonly "action.result"?: DiscordEventHandler<"action.result">;
  readonly "message.completed"?: DiscordEventHandler<"message.completed">;
  readonly "message.appended"?: DiscordEventHandler<"message.appended">;
  readonly "input.requested"?: DiscordEventHandler<"input.requested">;
  readonly "turn.failed"?: DiscordEventHandler<"turn.failed">;
  readonly "turn.completed"?: DiscordEventHandler<"turn.completed">;
  readonly "turn.cancelled"?: DiscordEventHandler<"turn.cancelled">;
  readonly "session.failed"?: DiscordSessionFailedHandler;
  readonly "session.completed"?: DiscordEventHandler<"session.completed">;
  readonly "session.waiting"?: DiscordEventHandler<"session.waiting">;
  readonly "authorization.required"?: DiscordEventHandler<"authorization.required">;
  readonly "authorization.completed"?: DiscordEventHandler<"authorization.completed">;
}

/** Configuration for {@link discordChannel}. */
export interface DiscordChannelConfig {
  readonly api?: Omit<DiscordApiOptions, "credentials">;
  readonly credentials?: DiscordChannelCredentials;
  /** Override the default interaction route path (`/eve/v1/discord`). */
  readonly route?: string;

  /** Inbound command hook. Defaults to user-scoped Discord auth and dispatch. Return `{ auth }` to dispatch, or `null` to acknowledge without running the agent. */
  onCommand?(
    ctx: DiscordContext,
    interaction: DiscordCommandInteraction,
  ): DiscordCommandResultOrPromise;

  readonly events?: DiscordChannelEvents;
}

/** Low-level Discord handle exposed to hooks and event handlers. */
export interface DiscordHandle {
  /** Discord application id when known. */
  readonly applicationId: string | undefined;
  /** Discord channel id. */
  readonly channelId: string;
  /** Current eve conversation id, usually the Discord anchor message id. */
  readonly conversationId: string;
  /** Discord guild id when known. */
  readonly guildId: string | undefined;
  /** Latest Discord interaction token when known. */
  readonly interactionToken: string | undefined;

  /** Raw Discord API escape hatch. */
  request(
    path: string,
    body: JsonObject,
    options?: DiscordRequestOptions,
  ): Promise<DiscordApiResponse>;
  /** Posts to the current conversation: interaction response or followup when an interaction token and application id exist, else a channel message. Splits over-length content, returning the first. */
  post(message: string | DiscordMessageBody): Promise<DiscordPostedMessage>;
  /** Sends a bot-authenticated message to this Discord channel. */
  sendChannelMessage(message: string | DiscordMessageBody): Promise<DiscordPostedMessage>;
  /** Edits the deferred original interaction response. */
  editOriginalResponse(message: string | DiscordMessageBody): Promise<DiscordPostedMessage>;
  /** Creates an interaction followup message. */
  followup(message: string | DiscordMessageBody): Promise<DiscordPostedMessage>;
  /** Triggers Discord's short-lived typing indicator. Ignores any failure. */
  startTyping(): Promise<void>;
}

/** Options for {@link DiscordHandle.request}. */
export interface DiscordRequestOptions {
  /** When `true`, attaches bot-token authorization; otherwise the raw request runs unauthenticated, suiting interaction webhook endpoints. */
  readonly botAuth?: boolean;
  /** HTTP method for the raw request. Defaults to `POST`. */
  readonly method?: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
}

/** Concrete return type of {@link discordChannel}. */
export interface DiscordChannel extends Channel<
  DiscordChannelState,
  DiscordReceiveTarget,
  DiscordInstrumentationMetadata
> {}

/** Discord channel factory for HTTP Interactions and proactive channel messages. */
export function discordChannel(config: DiscordChannelConfig = {}): DiscordChannel {
  const onCommand = config.onCommand ?? defaultOnCommand;
  const mergedEvents: DiscordChannelEvents = { ...defaultEvents, ...config.events };

  return defineChannel<
    DiscordChannelState,
    DiscordChannelContext,
    DiscordReceiveTarget,
    DiscordInstrumentationMetadata
  >({
    kindHint: "discord",
    state: initialDiscordState(),
    metadata: (state) => ({ channelId: state.channelId, guildId: state.guildId }),

    context(state, session) {
      return rebuildDiscordContext(state, session, config);
    },

    routes: [
      POST<DiscordChannelState>(
        config.route ?? "/eve/v1/discord",
        async (req, { send, waitUntil }) => {
          const body = await verifyDiscordInbound(req, config.credentials);
          if (body === null) return new Response("unauthorized", { status: 401 });

          let raw: JsonObject;
          try {
            raw = parseJsonObject(JSON.parse(body) as unknown);
          } catch (error) {
            log.warn("inbound Discord body is not valid JSON", { error });
            return discordJson({ content: "invalid request", ephemeral: true });
          }

          if (raw.type === DISCORD_INTERACTION_TYPE.PING) {
            return discordJson({ type: DISCORD_INTERACTION_RESPONSE_TYPE.PONG });
          }

          const interaction = parseDiscordInteraction(raw);
          if (interaction === null) {
            return discordJson({ content: "Unsupported Discord interaction.", ephemeral: true });
          }

          return handleInteraction({
            config,
            interaction,
            onCommand,
            send,
            waitUntil,
          });
        },
      ),
    ],

    async receive(input, { send }) {
      const receiveTarget = input.target as Partial<DiscordReceiveTarget>;
      const channelId = readString(receiveTarget.channelId);
      if (!channelId) {
        throw new Error("discordChannel().receive requires target.channelId.");
      }
      const requestedConversationId = readString(receiveTarget.conversationId);
      const initialMessage = receiveTarget.initialMessage;
      if (initialMessage !== undefined && requestedConversationId !== undefined) {
        throw new Error(
          "discordChannel().receive: `conversationId` and `initialMessage` are mutually exclusive.",
        );
      }

      let conversationId = requestedConversationId ?? "";
      let hasMessageAnchor = requestedConversationId !== undefined;
      if (initialMessage !== undefined) {
        const handle = buildDiscordHandle({
          config,
          state: {
            ...initialDiscordState(),
            channelId,
          },
        });
        const posted = await handle.sendChannelMessage(initialMessage);
        conversationId = posted.id;
        hasMessageAnchor = posted.id.length > 0;
      }

      return send(input.message, {
        auth: input.auth,
        continuationToken: discordContinuationToken(channelId, conversationId),
        state: {
          applicationId: null,
          channelId,
          conversationId: conversationId || null,
          guildId: null,
          hasMessageAnchor,
          initialResponseSent: true,
          interactionToken: null,
        },
      });
    },

    events: mergedEvents,
  });
}

function rebuildDiscordContext(
  state: DiscordChannelState,
  session: SessionHandle,
  config: DiscordChannelConfig,
): DiscordChannelContext {
  return {
    discord: buildDiscordHandle({ config, session, state }),
    state,
  };
}

function buildDiscordHandle(input: {
  readonly config: DiscordChannelConfig;
  readonly session?: SessionHandle;
  readonly state: DiscordChannelState;
}): DiscordHandle {
  const api = input.config.api;
  const state = input.state;
  const credentials = mergeCredentials(input.config.credentials, state);

  function anchor(posted: DiscordPostedMessage): void {
    if (!posted.id || state.hasMessageAnchor) return;
    state.conversationId = posted.id;
    state.hasMessageAnchor = true;
    if (state.channelId) {
      input.session?.setContinuationToken(discordContinuationToken(state.channelId, posted.id));
    }
  }

  async function sendViaChannel(
    message: string | DiscordMessageBody,
  ): Promise<DiscordPostedMessage> {
    const channelId = state.channelId ?? "";
    if (!channelId) throw new Error("discordChannel: missing channel id for outbound message.");
    const posted = await sendDiscordChannelMessage({
      apiBaseUrl: api?.apiBaseUrl,
      body: normalizePostInput(message),
      credentials,
      fetch: api?.fetch,
      channelId,
    });
    anchor(posted);
    return posted;
  }

  async function editOriginal(message: string | DiscordMessageBody): Promise<DiscordPostedMessage> {
    const interactionToken = state.interactionToken ?? "";
    if (!interactionToken) {
      throw new Error("discordChannel: missing interaction token for original response edit.");
    }
    const posted = await editDiscordOriginalResponse({
      apiBaseUrl: api?.apiBaseUrl,
      body: normalizePostInput(message),
      credentials,
      fetch: api?.fetch,
      interactionToken,
    });
    state.initialResponseSent = true;
    anchor(posted);
    return posted;
  }

  async function followup(message: string | DiscordMessageBody): Promise<DiscordPostedMessage> {
    const interactionToken = state.interactionToken ?? "";
    if (!interactionToken) {
      throw new Error("discordChannel: missing interaction token for followup message.");
    }
    const posted = await createDiscordFollowupMessage({
      apiBaseUrl: api?.apiBaseUrl,
      body: normalizePostInput(message),
      credentials,
      fetch: api?.fetch,
      interactionToken,
    });
    anchor(posted);
    return posted;
  }

  async function startTyping(): Promise<void> {
    const channelId = state.channelId ?? "";
    if (!channelId) return;
    try {
      await triggerDiscordTypingIndicator({
        apiBaseUrl: api?.apiBaseUrl,
        credentials,
        fetch: api?.fetch,
        channelId,
      });
    } catch (error) {
      logError(log, "Discord typing indicator failed — swallowed", error, { channelId });
    }
  }

  return {
    applicationId: state.applicationId ?? undefined,
    channelId: state.channelId ?? "",
    conversationId: state.conversationId ?? "",
    guildId: state.guildId ?? undefined,
    interactionToken: state.interactionToken ?? undefined,
    request(path, body, options) {
      return callDiscordApi({
        apiBaseUrl: api?.apiBaseUrl,
        body,
        botToken: options?.botAuth === true ? credentials.botToken : undefined,
        fetch: api?.fetch,
        method: options?.method,
        path,
      });
    },
    async post(message) {
      const bodies = expandPostBodies(normalizePostInput(message));
      let first: DiscordPostedMessage | undefined;
      for (const body of bodies) {
        const posted = await postOne({
          body,
          editOriginal,
          followup,
          sendViaChannel,
          state,
        });
        if (first === undefined) first = posted;
      }
      return first ?? { id: "", raw: null };
    },
    editOriginalResponse: editOriginal,
    followup,
    sendChannelMessage: sendViaChannel,
    startTyping,
  };
}

async function postOne(input: {
  readonly body: DiscordMessageBody;
  readonly editOriginal: (message: DiscordMessageBody) => Promise<DiscordPostedMessage>;
  readonly followup: (message: DiscordMessageBody) => Promise<DiscordPostedMessage>;
  readonly sendViaChannel: (message: DiscordMessageBody) => Promise<DiscordPostedMessage>;
  readonly state: DiscordChannelState;
}): Promise<DiscordPostedMessage> {
  if (input.state.interactionToken && input.state.applicationId) {
    try {
      if (!input.state.initialResponseSent) {
        return await input.editOriginal(input.body);
      }
      return await input.followup(input.body);
    } catch (error) {
      log.warn("Discord interaction-token delivery failed, falling back to channel message", {
        error,
      });
    }
  }
  return input.sendViaChannel(input.body);
}

async function handleInteraction(input: {
  readonly config: DiscordChannelConfig;
  readonly interaction: DiscordInteraction;
  readonly onCommand: NonNullable<DiscordChannelConfig["onCommand"]>;
  readonly send: SendFn<DiscordChannelState>;
  readonly waitUntil: (task: Promise<unknown>) => void;
}): Promise<Response> {
  if (input.interaction.type === DISCORD_INTERACTION_TYPE.APPLICATION_COMMAND) {
    return handleCommandInteraction({
      config: input.config,
      interaction: input.interaction,
      onCommand: input.onCommand,
      send: input.send,
      waitUntil: input.waitUntil,
    });
  }
  if (input.interaction.type === DISCORD_INTERACTION_TYPE.MESSAGE_COMPONENT) {
    return handleComponentInteraction({
      interaction: input.interaction,
      send: input.send,
      waitUntil: input.waitUntil,
    });
  }
  return handleModalSubmitInteraction({
    interaction: input.interaction,
    send: input.send,
    waitUntil: input.waitUntil,
  });
}

async function handleCommandInteraction(input: {
  readonly config: DiscordChannelConfig;
  readonly interaction: DiscordCommandInteraction;
  readonly onCommand: NonNullable<DiscordChannelConfig["onCommand"]>;
  readonly send: SendFn<DiscordChannelState>;
  readonly waitUntil: (task: Promise<unknown>) => void;
}): Promise<Response> {
  const state = stateFromInteraction(input.interaction, {
    conversationId: input.interaction.id,
    hasMessageAnchor: false,
    initialResponseSent: false,
  });
  const ctx: DiscordContext = {
    discord: buildDiscordHandle({ config: input.config, state }),
  };

  let result: DiscordCommandResult;
  try {
    result = await input.onCommand(ctx, input.interaction);
  } catch (error) {
    log.error("command handler failed", { error });
    return discordJson({ content: "The Discord command handler failed.", ephemeral: true });
  }
  if (result === null || result === undefined) {
    return discordJson({ content: "Command ignored.", ephemeral: true });
  }

  input.waitUntil(
    dispatchCommand({
      interaction: input.interaction,
      result,
      send: input.send,
      state,
    }),
  );
  return discordDeferredJson(result.ephemeral === true);
}

function handleComponentInteraction(input: {
  readonly interaction: DiscordComponentInteraction;
  readonly send: SendFn<DiscordChannelState>;
  readonly waitUntil: (task: Promise<unknown>) => void;
}): Response {
  if (isDiscordFreeformComponent(input.interaction.customId)) {
    const prompt = readMessageContent(input.interaction.raw);
    return discordJsonBody(
      buildFreeformModalResponse({
        customId: input.interaction.customId,
        prompt,
      }),
    );
  }

  const inputResponses = deriveComponentInputResponses(input.interaction);
  if (inputResponses.length > 0) {
    input.waitUntil(
      dispatchInputResponses({
        conversationId: input.interaction.messageId,
        inputResponses,
        interaction: input.interaction,
        send: input.send,
      }),
    );
  }
  return discordJsonBody({ type: DISCORD_INTERACTION_RESPONSE_TYPE.DEFERRED_UPDATE_MESSAGE });
}

function handleModalSubmitInteraction(input: {
  readonly interaction: DiscordModalSubmitInteraction;
  readonly send: SendFn<DiscordChannelState>;
  readonly waitUntil: (task: Promise<unknown>) => void;
}): Response {
  const inputResponses = deriveModalInputResponses(input.interaction);
  if (inputResponses.length > 0) {
    input.waitUntil(
      dispatchInputResponses({
        conversationId: input.interaction.messageId ?? input.interaction.id,
        inputResponses,
        interaction: input.interaction,
        send: input.send,
      }),
    );
  }
  return discordJson({ content: "Answer received.", ephemeral: true });
}

async function dispatchCommand(input: {
  readonly interaction: DiscordCommandInteraction;
  readonly result: Exclude<DiscordCommandResult, null>;
  readonly send: SendFn<DiscordChannelState>;
  readonly state: DiscordChannelState;
}): Promise<void> {
  const turnMessage = commandInteractionMessage(input.interaction);
  const contextBlock = formatDiscordContextBlock({
    channelId: input.interaction.channelId,
    commandName: input.interaction.commandName,
    guildId: input.interaction.guildId,
    interactionId: input.interaction.id,
    userId: input.interaction.user.id,
    username: input.interaction.user.username,
  });
  const channelContext = input.result.context ?? [];

  try {
    await input.send(
      {
        message: turnMessage,
        context: [contextBlock, ...channelContext],
      },
      {
        auth: input.result.auth,
        continuationToken: discordContinuationToken(
          input.interaction.channelId,
          input.interaction.id,
        ),
        state: input.state,
      },
    );
  } catch (error) {
    log.error("command delivery failed", { error });
  }
}

async function dispatchInputResponses(input: {
  readonly conversationId: string;
  readonly inputResponses: readonly { requestId: string; optionId?: string; text?: string }[];
  readonly interaction: DiscordComponentInteraction | DiscordModalSubmitInteraction;
  readonly send: SendFn<DiscordChannelState>;
}): Promise<void> {
  try {
    await input.send(
      { inputResponses: input.inputResponses },
      {
        auth: null,
        continuationToken: discordContinuationToken(
          input.interaction.channelId,
          input.conversationId,
        ),
        state: stateFromInteraction(input.interaction, {
          conversationId: input.conversationId,
          hasMessageAnchor: true,
          initialResponseSent: true,
        }),
      },
    );
  } catch (error) {
    log.error("interaction response delivery failed", { error });
  }
}

function stateFromInteraction(
  interaction: DiscordInteraction,
  options: {
    readonly conversationId: string;
    readonly hasMessageAnchor: boolean;
    readonly initialResponseSent: boolean;
  },
): DiscordChannelState {
  return {
    applicationId: interaction.applicationId,
    channelId: interaction.channelId,
    conversationId: options.conversationId,
    guildId: interaction.guildId ?? null,
    hasMessageAnchor: options.hasMessageAnchor,
    initialResponseSent: options.initialResponseSent,
    interactionToken: interaction.token,
  };
}

function initialDiscordState(): DiscordChannelState {
  return {
    applicationId: null,
    channelId: null,
    conversationId: null,
    guildId: null,
    hasMessageAnchor: false,
    initialResponseSent: false,
    interactionToken: null,
  };
}

function mergeCredentials(
  credentials: DiscordChannelCredentials | undefined,
  state: DiscordChannelState,
): DiscordChannelCredentials {
  const merged: DiscordChannelCredentials = {
    applicationId: state.applicationId ?? credentials?.applicationId,
    botToken: credentials?.botToken ?? (() => resolveDiscordBotToken()),
    publicKey: credentials?.publicKey,
    webhookVerifier: credentials?.webhookVerifier,
  };
  return merged;
}

function normalizePostInput(message: string | DiscordMessageBody): DiscordMessageBody {
  if (typeof message === "string") return { content: message };
  return message;
}

function expandPostBodies(body: DiscordMessageBody): readonly DiscordMessageBody[] {
  if (typeof body.content !== "string") return [body];
  const chunks = splitDiscordMessageContent(body.content);
  return chunks.map((content, index) => {
    if (index === 0) {
      return { ...body, content };
    }
    return {
      allowed_mentions: body.allowed_mentions,
      content,
    };
  });
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
