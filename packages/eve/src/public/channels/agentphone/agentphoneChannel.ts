import type { SessionHandle } from "#channel/session.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { SessionContext } from "#public/definitions/callback-context.js";
import type { ChannelSessionOps } from "#public/definitions/defineChannel.js";

import { createLogger } from "#internal/logging.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import {
  agentphoneContinuationToken,
  callAgentPhoneApi,
  makeAgentPhoneCall,
  sendAgentPhoneMessage,
  type AgentPhoneApiOptions,
  type AgentPhoneApiResponse,
  type AgentPhoneCredentials,
} from "#public/channels/agentphone/api.js";
import {
  defaultEvents,
  defaultOnCallEnded,
  defaultOnText,
  defaultOnVoice,
} from "#public/channels/agentphone/defaults.js";
import {
  formatAgentPhoneContextBlock,
  parseAgentPhoneCallEnded,
  parseAgentPhoneTextMessage,
  parseAgentPhoneVoiceMessage,
  type AgentPhoneCallEnded,
  type AgentPhoneTextMessage,
  type AgentPhoneVoiceMessage,
} from "#public/channels/agentphone/inbound.js";
import {
  verifyAgentPhoneRequest,
  type AgentPhoneWebhookSecret,
} from "#public/channels/agentphone/verify.js";
import {
  defineChannel,
  POST,
  type Channel,
  type SendFn,
} from "#public/definitions/defineChannel.js";

const log = createLogger("agentphone.channel");

type EventData<T extends HandleMessageStreamEvent["type"]> =
  Extract<HandleMessageStreamEvent, { type: T }> extends { data: infer D } ? D : undefined;

/** Pre-dispatch AgentPhone context passed to inbound hooks. */
export interface AgentPhoneContext {
  readonly agentphone: AgentPhoneHandle;
}

/** Channel-owned AgentPhone context returned by `context()`. */
export interface AgentPhoneChannelContext extends AgentPhoneContext {
  state: AgentPhoneChannelState;
}

/** Event-handler AgentPhone context, including session operations. */
export interface AgentPhoneEventContext extends AgentPhoneChannelContext, ChannelSessionOps {}

/** JSON-serializable state for the phone-number conversation. */
export interface AgentPhoneChannelState {
  /** Caller / sender phone number. */
  from: string | null;
  /** AgentPhone number that received the latest session-starting webhook. */
  to: string | null;
  /** Most recent conversation ID when this session was started by text. */
  lastConversationId?: string | null;
  /** Most recent call ID when this session was started by voice. */
  lastCallId?: string | null;
}

/** Per-session instrumentation snapshot for AgentPhone runtime telemetry. */
export interface AgentPhoneInstrumentationMetadata extends Record<string, unknown> {
  readonly from: string | null;
  readonly lastCallId: string | null;
  readonly lastConversationId: string | null;
  readonly to: string | null;
}

/** AgentPhone channel credentials. */
export interface AgentPhoneChannelCredentials extends AgentPhoneCredentials {
  readonly webhookSecret?: AgentPhoneWebhookSecret;
}

/** Target accepted by `receive(agentphone, { target })` for proactive sessions. */
export interface AgentPhoneReceiveTarget {
  readonly phoneNumber: string;
  /** AgentPhone sender number included in the continuation token. */
  readonly from?: string;
}

/** Result of an inbound AgentPhone text or call-ended hook. Return `null` to drop the webhook. */
export type AgentPhoneInboundResult = {
  auth: SessionAuthContext | null;
} | null;

/** Sync or async {@link AgentPhoneInboundResult}. */
export type AgentPhoneInboundResultOrPromise =
  | AgentPhoneInboundResult
  | Promise<AgentPhoneInboundResult>;

/** Phone-number allow list for inbound AgentPhone webhooks. `"*"` allows every sender. */
export type AgentPhoneAllowFrom =
  | string
  | readonly string[]
  | (() => string | readonly string[] | Promise<string | readonly string[]>);

/**
 * Result of an inbound AgentPhone voice hook. Return `null` to reject.
 * Any non-null result accepts the voice webhook and can supply a text
 * response for the agent to speak.
 */
export interface AgentPhoneVoiceResult {
  /** Text for the agent to speak in response. */
  readonly text?: string;
  /** Whether to hang up after speaking. */
  readonly hangup?: boolean;
}

/** Sync or async {@link AgentPhoneVoiceResult}. */
export type AgentPhoneVoiceResultOrPromise =
  | AgentPhoneVoiceResult
  | null
  | undefined
  | Promise<AgentPhoneVoiceResult | null | undefined>;

type AgentPhoneEventHandler<T extends HandleMessageStreamEvent["type"]> = (
  data: EventData<T>,
  channel: AgentPhoneEventContext,
  ctx: SessionContext,
) => void | Promise<void>;

type AgentPhoneSessionFailedHandler = (
  data: EventData<"session.failed">,
  channel: AgentPhoneEventContext,
) => void | Promise<void>;

/** Event handlers supported by `agentphoneChannel({ events })`. */
export interface AgentPhoneChannelEvents {
  readonly "turn.started"?: AgentPhoneEventHandler<"turn.started">;
  readonly "actions.requested"?: AgentPhoneEventHandler<"actions.requested">;
  readonly "action.result"?: AgentPhoneEventHandler<"action.result">;
  readonly "message.completed"?: AgentPhoneEventHandler<"message.completed">;
  readonly "message.appended"?: AgentPhoneEventHandler<"message.appended">;
  readonly "input.requested"?: AgentPhoneEventHandler<"input.requested">;
  readonly "turn.failed"?: AgentPhoneEventHandler<"turn.failed">;
  readonly "turn.completed"?: AgentPhoneEventHandler<"turn.completed">;
  readonly "session.failed"?: AgentPhoneSessionFailedHandler;
  readonly "session.completed"?: AgentPhoneEventHandler<"session.completed">;
  readonly "session.waiting"?: AgentPhoneEventHandler<"session.waiting">;
  readonly "authorization.required"?: AgentPhoneEventHandler<"authorization.required">;
  readonly "authorization.completed"?: AgentPhoneEventHandler<"authorization.completed">;
}

/** SMS/Messaging defaults for AgentPhone outbound replies. */
export interface AgentPhoneMessagingConfig {
  /** Sender phone number. Defaults to the inbound `to` number when available. */
  readonly from?: string;
  /** Send from a specific AgentPhone number ID. */
  readonly numberId?: string;
  /** AgentPhone agent ID used for outbound messages. */
  readonly agentId?: string;
}

/** Configuration for {@link agentphoneChannel}. */
export interface AgentPhoneChannelConfig {
  readonly credentials?: AgentPhoneChannelCredentials;
  /**
   * Base route for AgentPhone webhooks. Defaults to `/eve/v1/agentphone`
   * and mounts `/webhooks` below it.
   */
  readonly route?: string;
  /**
   * Exact caller/sender numbers allowed to reach inbound hooks, or `"*"` to
   * allow every verified AgentPhone sender. Resolvers run on each inbound webhook.
   */
  readonly allowFrom: AgentPhoneAllowFrom;
  readonly messaging?: AgentPhoneMessagingConfig;
  readonly api?: Omit<AgentPhoneApiOptions, "credentials">;

  /** Inbound text hook. Defaults to phone-number auth and dispatch. */
  onText?(ctx: AgentPhoneContext, message: AgentPhoneTextMessage): AgentPhoneInboundResultOrPromise;
  /** Inbound voice hook. Return `null` to reject. */
  onVoice?(ctx: AgentPhoneContext, message: AgentPhoneVoiceMessage): AgentPhoneVoiceResultOrPromise;
  /** Inbound call-ended hook. Defaults to phone-number auth and dispatch. */
  onCallEnded?(
    ctx: AgentPhoneContext,
    callEnded: AgentPhoneCallEnded,
  ): AgentPhoneInboundResultOrPromise;

  readonly events?: AgentPhoneChannelEvents;
}

/** Low-level AgentPhone handle exposed to hooks and event handlers. */
export interface AgentPhoneHandle {
  /** Caller / sender phone number bound to this conversation. */
  readonly from: string;
  /** AgentPhone receiver / sender number for replies, when known. */
  readonly to: string | undefined;
  /** Most recent call ID, when the session started from a voice webhook. */
  readonly callId: string | undefined;
  /** Raw AgentPhone REST API escape hatch. */
  request(path: string, body: Record<string, unknown>): Promise<AgentPhoneApiResponse>;
  /** Sends a text message to this conversation's phone number by default. */
  sendMessage(
    message: string,
    options?: AgentPhoneSendMessageOptions,
  ): Promise<AgentPhoneApiResponse>;
  /** Initiates an outbound call. */
  makeCall(options: AgentPhoneMakeCallOptions): Promise<AgentPhoneApiResponse>;
}

/** Per-call overrides for {@link AgentPhoneHandle.sendMessage}. */
export interface AgentPhoneSendMessageOptions {
  /** Recipient phone number. Defaults to the conversation's `from` number. */
  readonly to?: string;
  /** Sender phone number. Defaults to `messaging.from`. */
  readonly from?: string;
  /** AgentPhone number ID. Defaults to `messaging.numberId`. */
  readonly numberId?: string;
  /** Media attachment URLs. */
  readonly mediaUrls?: readonly string[];
}

/** Options for {@link AgentPhoneHandle.makeCall}. */
export interface AgentPhoneMakeCallOptions {
  /** AgentPhone agent ID. Required. */
  readonly agentId: string;
  /** Recipient phone number. Defaults to the conversation's `from` number. */
  readonly to?: string;
  /** What to say when the recipient answers. */
  readonly initialGreeting?: string;
}

/** Concrete return type of {@link agentphoneChannel}. */
export interface AgentPhoneChannel extends Channel<
  AgentPhoneChannelState,
  AgentPhoneReceiveTarget,
  AgentPhoneInstrumentationMetadata
> {}

/** AgentPhone channel factory for SMS, MMS, iMessage, and voice. */
export function agentphoneChannel(config: AgentPhoneChannelConfig): AgentPhoneChannel {
  assertAllowFromConfigured(config);
  const routes = buildRoutes(config.route ?? "/eve/v1/agentphone");
  const onText = config.onText ?? defaultOnText;
  const onVoice = config.onVoice ?? defaultOnVoice;
  const onCallEnded = config.onCallEnded ?? defaultOnCallEnded;
  const mergedEvents: AgentPhoneChannelEvents = { ...defaultEvents, ...config.events };

  return defineChannel<
    AgentPhoneChannelState,
    AgentPhoneChannelContext,
    AgentPhoneReceiveTarget,
    AgentPhoneInstrumentationMetadata
  >({
    kindHint: "agentphone",
    state: {
      from: null as string | null,
      to: null as string | null,
      lastCallId: null,
      lastConversationId: null,
    },
    metadata(state): AgentPhoneInstrumentationMetadata {
      return {
        from: state.from,
        lastCallId: state.lastCallId ?? null,
        lastConversationId: state.lastConversationId ?? null,
        to: state.to,
      };
    },

    context(state, session) {
      return rebuildAgentPhoneContext(state, session, config);
    },

    routes: [
      POST<AgentPhoneChannelState>(routes.webhooks, async (req, { send, waitUntil }) => {
        const verified = await verifyInbound(req, config);
        if (verified === null) return new Response("unauthorized", { status: 401 });

        const payload = verified.payload as Record<string, unknown>;
        const event = payload.event as string | undefined;
        const channel = payload.channel as string | undefined;

        if (event === "agent.message" && channel === "voice") {
          const voice = parseAgentPhoneVoiceMessage(payload);
          if (!voice) return jsonResponse({});
          if (!(await isAllowed(voice.from, config.allowFrom)))
            return new Response("forbidden", { status: 403 });

          const voiceResult = await acceptVoiceWebhook({
            config,
            message: voice,
            onVoice,
          });
          if (voiceResult === null) return new Response("forbidden", { status: 403 });

          waitUntil(dispatchVoice({ config, message: voice, onVoice, send }));
          return jsonResponse(voiceResult ?? {});
        }

        if (event === "agent.message") {
          const message = parseAgentPhoneTextMessage(payload);
          if (!message) return jsonResponse({ status: "ok" });
          if (!(await isAllowed(message.from, config.allowFrom)))
            return new Response("forbidden", { status: 403 });

          waitUntil(dispatchText({ config, message, onText, send }));
          return jsonResponse({ status: "ok" });
        }

        if (event === "agent.call_ended") {
          const callEnded = parseAgentPhoneCallEnded(payload);
          if (!callEnded) return jsonResponse({ status: "ok" });
          if (!(await isAllowed(callEnded.from, config.allowFrom)))
            return new Response("forbidden", { status: 403 });

          waitUntil(dispatchCallEnded({ callEnded, config, onCallEnded, send }));
          return jsonResponse({ status: "ok" });
        }

        return jsonResponse({ status: "ok" });
      }),
    ],

    async receive(input, { send }) {
      const phoneNumber = readString(input.target.phoneNumber);
      if (!phoneNumber) {
        throw new Error("agentphoneChannel().receive requires target.phoneNumber.");
      }
      const from = readString(input.target.from) ?? config.messaging?.from ?? null;
      return send(input.message, {
        auth: input.auth,
        continuationToken: agentphoneContinuationToken(phoneNumber, from ?? undefined),
        state: {
          from: phoneNumber,
          lastCallId: null,
          lastConversationId: null,
          to: from,
        },
      });
    },

    events: mergedEvents,
  });
}

function rebuildAgentPhoneContext(
  state: AgentPhoneChannelState,
  _session: SessionHandle,
  config: AgentPhoneChannelConfig,
): AgentPhoneChannelContext {
  return {
    state,
    agentphone: buildAgentPhoneHandle({
      callId: state.lastCallId ?? undefined,
      config,
      from: state.from ?? "",
      to: state.to ?? undefined,
    }),
  };
}

function buildAgentPhoneHandle(input: {
  readonly callId: string | undefined;
  readonly config: AgentPhoneChannelConfig;
  readonly from: string;
  readonly to: string | undefined;
}): AgentPhoneHandle {
  const api = input.config.api;
  const credentials = input.config.credentials;
  const defaultFrom = input.config.messaging?.from ?? input.to;
  const defaultNumberId = input.config.messaging?.numberId;
  const defaultAgentId = input.config.messaging?.agentId;

  return {
    callId: input.callId,
    from: input.from,
    to: input.to,
    request(path, body) {
      return callAgentPhoneApi({
        apiBaseUrl: api?.apiBaseUrl,
        body,
        credentials,
        fetch: api?.fetch,
        path,
      });
    },
    sendMessage(message, options) {
      return sendAgentPhoneMessage({
        agentId: defaultAgentId,
        apiBaseUrl: api?.apiBaseUrl,
        body: message,
        credentials,
        fetch: api?.fetch,
        fromNumber: options?.from ?? defaultFrom,
        mediaUrls: options?.mediaUrls,
        numberId: options?.numberId ?? defaultNumberId,
        toNumber: options?.to ?? input.from,
      });
    },
    makeCall(options) {
      return makeAgentPhoneCall({
        agentId: options.agentId,
        apiBaseUrl: api?.apiBaseUrl,
        credentials,
        fetch: api?.fetch,
        initialGreeting: options.initialGreeting,
        toNumber: options.to ?? input.from,
      });
    },
  };
}

function buildRoutes(baseRoute: string): { webhooks: string } {
  const base = baseRoute.endsWith("/") ? baseRoute.slice(0, -1) : baseRoute;
  return { webhooks: `${base}/webhooks` };
}

function assertAllowFromConfigured(
  config: AgentPhoneChannelConfig | undefined,
): asserts config is AgentPhoneChannelConfig {
  if (config?.allowFrom === undefined) {
    throw new Error(
      'agentphoneChannel requires allowFrom. Use allowFrom: "*" to allow all numbers.',
    );
  }
}

async function verifyInbound(
  req: Request,
  config: AgentPhoneChannelConfig,
): Promise<{ body: string; payload: unknown } | null> {
  try {
    return await verifyAgentPhoneRequest(req, {
      webhookSecret: config.credentials?.webhookSecret,
    });
  } catch (error) {
    log.warn("agentphone inbound verification failed", { error });
    return null;
  }
}

async function dispatchText(input: {
  readonly config: AgentPhoneChannelConfig;
  readonly message: AgentPhoneTextMessage;
  readonly onText: NonNullable<AgentPhoneChannelConfig["onText"]>;
  readonly send: SendFn<AgentPhoneChannelState>;
}): Promise<void> {
  const { message } = input;
  const agentphone: AgentPhoneContext = {
    agentphone: buildAgentPhoneHandle({
      callId: undefined,
      config: input.config,
      from: message.from,
      to: message.to,
    }),
  };

  let result: AgentPhoneInboundResult;
  try {
    result = await input.onText(agentphone, message);
  } catch (error) {
    log.error("text handler failed", { error });
    return;
  }
  if (result === null || result === undefined) return;

  const contextBlock = formatAgentPhoneContextBlock({
    channel: message.channel,
    conversationId: message.conversationId,
    from: message.from,
    to: message.to,
  });

  try {
    await input.send(
      {
        message: message.body,
        context: [contextBlock],
      },
      {
        auth: result.auth,
        continuationToken: agentphoneContinuationToken(message.from, message.to),
        state: {
          from: message.from,
          lastCallId: null,
          lastConversationId: message.conversationId ?? null,
          to: message.to ?? null,
        },
      },
    );
  } catch (error) {
    log.error("text delivery failed", { error });
  }
}

async function acceptVoiceWebhook(input: {
  readonly config: AgentPhoneChannelConfig;
  readonly message: AgentPhoneVoiceMessage;
  readonly onVoice: NonNullable<AgentPhoneChannelConfig["onVoice"]>;
}): Promise<AgentPhoneVoiceResult | null | undefined> {
  const agentphone: AgentPhoneContext = {
    agentphone: buildAgentPhoneHandle({
      callId: input.message.callId,
      config: input.config,
      from: input.message.from,
      to: input.message.to,
    }),
  };

  try {
    return await input.onVoice(agentphone, input.message);
  } catch (error) {
    log.error("voice handler failed", { error });
    return null;
  }
}

async function dispatchVoice(input: {
  readonly config: AgentPhoneChannelConfig;
  readonly message: AgentPhoneVoiceMessage;
  readonly onVoice: NonNullable<AgentPhoneChannelConfig["onVoice"]>;
  readonly send: SendFn<AgentPhoneChannelState>;
}): Promise<void> {
  const { message } = input;
  const agentphone: AgentPhoneContext = {
    agentphone: buildAgentPhoneHandle({
      callId: message.callId,
      config: input.config,
      from: message.from,
      to: message.to,
    }),
  };

  let result: AgentPhoneInboundResult;
  try {
    const voiceResult = await input.onVoice(agentphone, message);
    if (voiceResult === null || voiceResult === undefined) return;
    result = {
      auth: defaultAgentPhoneAuthFromVoice(message),
    };
  } catch (error) {
    log.error("voice dispatch failed", { error });
    return;
  }
  if (result === null || result === undefined) return;

  const contextBlock = formatAgentPhoneContextBlock({
    callId: message.callId,
    channel: "voice",
    from: message.from,
    to: message.to,
  });

  try {
    await input.send(
      {
        message: message.transcript,
        context: [contextBlock],
      },
      {
        auth: result.auth,
        continuationToken: agentphoneContinuationToken(message.from, message.to),
        state: {
          from: message.from,
          lastCallId: message.callId ?? null,
          lastConversationId: null,
          to: message.to ?? null,
        },
      },
    );
  } catch (error) {
    log.error("voice delivery failed", { error });
  }
}

async function dispatchCallEnded(input: {
  readonly callEnded: AgentPhoneCallEnded;
  readonly config: AgentPhoneChannelConfig;
  readonly onCallEnded: NonNullable<AgentPhoneChannelConfig["onCallEnded"]>;
  readonly send: SendFn<AgentPhoneChannelState>;
}): Promise<void> {
  const { callEnded } = input;
  const agentphone: AgentPhoneContext = {
    agentphone: buildAgentPhoneHandle({
      callId: callEnded.callId,
      config: input.config,
      from: callEnded.from,
      to: callEnded.to,
    }),
  };

  let result: AgentPhoneInboundResult;
  try {
    result = await input.onCallEnded(agentphone, callEnded);
  } catch (error) {
    log.error("call-ended handler failed", { error });
    return;
  }
  if (result === null || result === undefined) return;

  const summaryText = callEnded.summary
    ? `Call ended. Summary: ${callEnded.summary}`
    : "Call ended.";

  const contextBlock = formatAgentPhoneContextBlock({
    callId: callEnded.callId,
    channel: "voice",
    from: callEnded.from,
    to: callEnded.to,
  });

  try {
    await input.send(
      {
        message: summaryText,
        context: [contextBlock],
      },
      {
        auth: result.auth,
        continuationToken: agentphoneContinuationToken(callEnded.from, callEnded.to),
        state: {
          from: callEnded.from,
          lastCallId: callEnded.callId ?? null,
          lastConversationId: null,
          to: callEnded.to ?? null,
        },
      },
    );
  } catch (error) {
    log.error("call-ended delivery failed", { error });
  }
}

function defaultAgentPhoneAuthFromVoice(message: AgentPhoneVoiceMessage) {
  const attributes: Record<string, string> = {
    channel: "voice",
    from: message.from,
  };
  if (message.to) attributes.to = message.to;

  return {
    attributes,
    authenticator: "agentphone-webhook",
    issuer: "agentphone",
    principalId: `agentphone:${message.from}`,
    principalType: "user" as const,
  };
}

async function isAllowed(from: string, allowFrom: AgentPhoneAllowFrom): Promise<boolean> {
  const resolved = typeof allowFrom === "function" ? await allowFrom() : allowFrom;
  if (resolved === "*") return true;
  return typeof resolved === "string" ? resolved === from : resolved.includes(from);
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
