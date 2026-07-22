import type { SessionHandle } from "#channel/session.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { RouteHandler } from "#channel/routes.js";
import type { SessionContext } from "#public/definitions/callback-context.js";
import type { ChannelSessionOps } from "#public/definitions/channel.js";

import { createLogger } from "#internal/logging.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import {
  callTwilioApi,
  sendTwilioMessage,
  twilioContinuationToken,
  updateTwilioCall,
  type TwilioApiOptions,
  type TwilioApiResponse,
  type TwilioCredentials,
} from "#public/channels/twilio/api.js";
import {
  defaultEvents,
  defaultOnText,
  defaultOnVoice,
  defaultOnVoiceTranscription,
} from "#public/channels/twilio/defaults.js";
import {
  formatTwilioContextBlock,
  parseTwilioTextMessage,
  parseTwilioVoiceCall,
  parseTwilioVoiceTranscription,
  type TwilioTextMessage,
  type TwilioVoiceCall,
  type TwilioVoiceTranscription,
} from "#public/channels/twilio/inbound.js";
import {
  emptyTwilioResponse,
  gatherSpeechTwilioResponse,
  sayTwilioResponse,
} from "#public/channels/twilio/twiml.js";
import {
  buildTwilioActionUrl,
  buildTwilioRoutes,
  verifyTwilioInbound,
  type TwilioRoutes,
} from "#public/channels/twilio/routing.js";
import { type TwilioAuthToken, type TwilioWebhookUrl } from "#public/channels/twilio/verify.js";
import {
  defineChannel,
  GET,
  POST,
  type Channel,
  type SendFn,
} from "#public/definitions/channel.js";

const log = createLogger("twilio.channel");

type EventData<T extends HandleMessageStreamEvent["type"]> =
  Extract<HandleMessageStreamEvent, { type: T }> extends { data: infer D } ? D : undefined;

/** Pre-dispatch Twilio context passed to the inbound text, voice, and voice-transcription hooks. */
export interface TwilioContext {
  readonly twilio: TwilioHandle;
}

/** Channel-owned Twilio context returned by `context()`. */
export interface TwilioChannelContext extends TwilioContext {
  state: TwilioChannelState;
}

/** Event-handler Twilio context, including session operations. */
export interface TwilioEventContext extends TwilioChannelContext, ChannelSessionOps {}

/** JSON-serializable state for the phone-number conversation. */
export interface TwilioChannelState {
  /** Caller / sender phone number. */
  from: string | null;
  /** Twilio number or sender that received the latest session-starting webhook. */
  to: string | null;
  /** Most recent inbound SMS SID when this session was started by text. */
  lastMessageSid?: string | null;
  /** Most recent inbound Call SID when this session was started by voice. */
  lastCallSid?: string | null;
}

/** Per-session instrumentation snapshot for Twilio runtime telemetry. Reports the active phone-number pair and the most recent message and call SIDs. */
export interface TwilioInstrumentationMetadata extends Record<string, unknown> {
  readonly from: string | null;
  readonly lastCallSid: string | null;
  readonly lastMessageSid: string | null;
  readonly to: string | null;
}

/** Twilio channel credentials. `authToken` also verifies inbound webhook signatures. */
export interface TwilioChannelCredentials extends TwilioCredentials {
  readonly authToken?: TwilioAuthToken;
}

/** Target accepted by `receive(twilio, { target })` for proactive phone-number sessions. */
export interface TwilioReceiveTarget {
  readonly phoneNumber: string;
  /** Twilio sender included in the phone-pair continuation token. */
  readonly from?: string;
}

/** Result of an inbound Twilio text or transcription hook. Return `null` (or `undefined`) to drop the webhook without dispatching; otherwise supply the session `auth` context. */
export type TwilioInboundResult = {
  auth: SessionAuthContext | null;
} | null;

/** Sync or async {@link TwilioInboundResult}. */
export type TwilioInboundResultOrPromise = TwilioInboundResult | Promise<TwilioInboundResult>;

/** Phone-number allow list for inbound Twilio webhook triggers. `"*"` allows every sender. */
export type TwilioAllowFrom =
  | string
  | readonly string[]
  | (() => string | readonly string[] | Promise<string | readonly string[]>);

/**
 * Result of an inbound Twilio voice hook. Return `null` to reject the call.
 * Any result other than `null` accepts the call and can override the answering TwiML.
 */
export interface TwilioVoiceResult {
  /** Prompt spoken before Twilio starts speech recognition. */
  readonly prompt?: string;
  /** BCP 47 language used for speech recognition and the nested `<Say>` prompt. */
  readonly language?: string;
  /** Twilio `<Say voice>` used for the prompt, e.g. `Polly.Joanna-Neural`. */
  readonly voice?: string;
  /** Twilio `<Gather speechModel>` used for speech recognition. */
  readonly speechModel?: string;
  /** Twilio `<Gather timeout>` in seconds. */
  readonly timeoutSeconds?: number;
  /** Twilio `<Gather speechTimeout>`, such as `"auto"` or a second count string. */
  readonly speechTimeout?: string;
  /** Twilio `<Gather hints>` for expected words or phrases. */
  readonly hints?: string | readonly string[];
  /** Twilio `<Gather profanityFilter>` toggle. */
  readonly profanityFilter?: boolean;
}

/** Sync or async {@link TwilioVoiceResult}. */
export type TwilioVoiceResultOrPromise =
  | TwilioVoiceResult
  | null
  | undefined
  | Promise<TwilioVoiceResult | null | undefined>;

type TwilioEventHandler<T extends HandleMessageStreamEvent["type"]> = (
  data: EventData<T>,
  channel: TwilioEventContext,
  ctx: SessionContext,
) => void | Promise<void>;

type TwilioSessionFailedHandler = (
  data: EventData<"session.failed">,
  channel: TwilioEventContext,
) => void | Promise<void>;

/** Event handlers supported by `twilioChannel({ events })`. */
export interface TwilioChannelEvents {
  readonly "turn.started"?: TwilioEventHandler<"turn.started">;
  readonly "actions.requested"?: TwilioEventHandler<"actions.requested">;
  readonly "action.result"?: TwilioEventHandler<"action.result">;
  readonly "message.completed"?: TwilioEventHandler<"message.completed">;
  readonly "message.appended"?: TwilioEventHandler<"message.appended">;
  readonly "input.requested"?: TwilioEventHandler<"input.requested">;
  readonly "turn.failed"?: TwilioEventHandler<"turn.failed">;
  readonly "turn.completed"?: TwilioEventHandler<"turn.completed">;
  readonly "turn.cancelled"?: TwilioEventHandler<"turn.cancelled">;
  readonly "session.failed"?: TwilioSessionFailedHandler;
  readonly "session.completed"?: TwilioEventHandler<"session.completed">;
  readonly "session.waiting"?: TwilioEventHandler<"session.waiting">;
  readonly "authorization.required"?: TwilioEventHandler<"authorization.required">;
  readonly "authorization.completed"?: TwilioEventHandler<"authorization.completed">;
}

/** SMS/Messaging defaults for Twilio outbound replies. */
export interface TwilioMessagingConfig {
  /** Sender phone number. Defaults to the inbound `To` number when available. */
  readonly from?: string;
  /** Messaging Service SID. Used instead of `from` when supplied. */
  readonly messagingServiceSid?: string;
  /** Optional Twilio status callback URL for outbound messages. */
  readonly statusCallbackUrl?: string;
}

/** Voice webhook defaults for accepting calls and gathering speech. */
export interface TwilioVoiceConfig {
  /** Prompt spoken when a caller reaches the voice route. */
  readonly prompt?: string;
  /** Twilio `<Say voice>` used for the prompt, e.g. `Polly.Joanna-Neural`. */
  readonly voice?: string;
  /** Spoken acknowledgement after a transcription webhook is accepted. */
  readonly acknowledgement?: string;
  /** BCP 47 language used for speech recognition and the nested `<Say>` prompt. */
  readonly language?: string;
  /** Twilio `<Gather speechModel>` used for speech recognition. */
  readonly speechModel?: string;
  /** Twilio `<Gather timeout>` in seconds. */
  readonly timeoutSeconds?: number;
  /** Twilio `<Gather speechTimeout>`, such as `"auto"` or a second count string. */
  readonly speechTimeout?: string;
  /** Twilio `<Gather hints>` for expected words or phrases. */
  readonly hints?: string | readonly string[];
  /** Twilio `<Gather profanityFilter>` toggle. */
  readonly profanityFilter?: boolean;
}

/** Configuration for {@link twilioChannel}. */
export interface TwilioChannelConfig {
  readonly credentials?: TwilioChannelCredentials;
  /**
   * Base route for Twilio webhooks. Defaults to `/eve/v1/twilio` and
   * mounts `/messages`, `/voice`, and `/voice/transcription` below it.
   */
  readonly route?: string;
  /**
   * Public URL Twilio used for signing. Set this when proxies or local
   * tunnels make `request.url` differ from the configured webhook URL.
   */
  readonly webhookUrl?: TwilioWebhookUrl;
  /** Public base URL used to render absolute voice `<Gather action>` URLs. */
  readonly publicBaseUrl?: string | ((request: Request) => string | Promise<string>);
  /**
   * Exact caller/sender numbers allowed to reach inbound hooks, or `"*"` to
   * allow every verified Twilio sender. Resolvers run on each inbound webhook.
   */
  readonly allowFrom: TwilioAllowFrom;
  readonly messaging?: TwilioMessagingConfig;
  readonly voice?: TwilioVoiceConfig;
  readonly api?: Omit<TwilioApiOptions, "credentials">;

  /** Inbound text hook. Defaults to phone-number auth and dispatch. */
  onText?(ctx: TwilioContext, message: TwilioTextMessage): TwilioInboundResultOrPromise;
  /** Inbound voice hook. Return `null` to reject the call before gathering speech. */
  onVoice?(ctx: TwilioContext, call: TwilioVoiceCall): TwilioVoiceResultOrPromise;
  /** Inbound voice transcription hook. Defaults to phone-number auth and dispatch. */
  onVoiceTranscription?(
    ctx: TwilioContext,
    transcription: TwilioVoiceTranscription,
  ): TwilioInboundResultOrPromise;

  readonly events?: TwilioChannelEvents;
}

/** Low-level Twilio handle exposed to hooks and event handlers. */
export interface TwilioHandle {
  /** Caller / sender phone number bound to this conversation. */
  readonly from: string;
  /** Twilio receiver / sender number for replies, when known. */
  readonly to: string | undefined;
  /** Most recent call SID, when the session started from a voice transcription. */
  readonly callSid: string | undefined;
  /** Raw Twilio REST API escape hatch. `path` is appended to the API base URL (default `https://api.twilio.com`). `body` fields are POSTed as form-encoded parameters. */
  request(
    path: string,
    body: Readonly<Record<string, string | number | boolean | undefined | null>>,
  ): Promise<TwilioApiResponse>;
  /** Sends a text message to this conversation's phone number by default. */
  sendMessage(message: string, options?: TwilioSendMessageOptions): Promise<TwilioApiResponse>;
  /** Updates a live call with replacement TwiML. */
  updateCall(callSid: string, twiml: string): Promise<TwilioApiResponse>;
}

/** Per-call overrides for {@link TwilioHandle.sendMessage}. */
export interface TwilioSendMessageOptions {
  /** Recipient phone number. Defaults to the conversation's `from` number. */
  readonly to?: string;
  /** Sender phone number. Defaults to `messaging.from`, falling back to the inbound `To` number. */
  readonly from?: string;
  /** Messaging Service SID. Defaults to `messaging.messagingServiceSid`. */
  readonly messagingServiceSid?: string;
  /** Twilio status callback URL. Defaults to `messaging.statusCallbackUrl`. */
  readonly statusCallbackUrl?: string;
}

/** Concrete return type of {@link twilioChannel}. */
export interface TwilioChannel extends Channel<
  TwilioChannelState,
  TwilioReceiveTarget,
  TwilioInstrumentationMetadata
> {}

/** Twilio channel factory for SMS and speech-transcribed inbound calls. */
export function twilioChannel(config: TwilioChannelConfig): TwilioChannel {
  assertAllowFromConfigured(config);
  const routes = buildTwilioRoutes(config.route ?? "/eve/v1/twilio");
  const onText = config.onText ?? defaultOnText;
  const onVoice = config.onVoice ?? defaultOnVoice;
  const onVoiceTranscription = config.onVoiceTranscription ?? defaultOnVoiceTranscription;
  const mergedEvents: TwilioChannelEvents = { ...defaultEvents, ...config.events };
  const messages = handleTwilioMessages({ config, onText });
  const voice = handleTwilioVoice({ config, onVoice, routes });
  const transcription = handleTwilioTranscription({ config, onVoiceTranscription, routes });

  return defineChannel<
    TwilioChannelState,
    TwilioChannelContext,
    TwilioReceiveTarget,
    TwilioInstrumentationMetadata
  >({
    kindHint: "twilio",
    state: {
      from: null as string | null,
      to: null as string | null,
      lastCallSid: null,
      lastMessageSid: null,
    },
    metadata(state): TwilioInstrumentationMetadata {
      return {
        from: state.from,
        lastCallSid: state.lastCallSid ?? null,
        lastMessageSid: state.lastMessageSid ?? null,
        to: state.to,
      };
    },

    context(state, session) {
      return rebuildTwilioContext(state, session, config);
    },

    routes: [
      GET<TwilioChannelState>(routes.messages, messages),
      POST<TwilioChannelState>(routes.messages, messages),
      GET<TwilioChannelState>(routes.voice, voice),
      POST<TwilioChannelState>(routes.voice, voice),
      GET<TwilioChannelState>(routes.transcription, transcription),
      POST<TwilioChannelState>(routes.transcription, transcription),
    ],

    async receive(input, { send }) {
      const phoneNumber = readString(input.target.phoneNumber);
      if (!phoneNumber) {
        throw new Error("twilioChannel().receive requires target.phoneNumber.");
      }
      const from = readString(input.target.from) ?? config.messaging?.from ?? null;
      return send(input.message, {
        auth: input.auth,
        continuationToken: twilioContinuationToken(phoneNumber, from ?? undefined),
        state: {
          from: phoneNumber,
          lastCallSid: null,
          lastMessageSid: null,
          to: from,
        },
      });
    },

    events: mergedEvents,
  });
}

function handleTwilioMessages(input: {
  readonly config: TwilioChannelConfig;
  readonly onText: NonNullable<TwilioChannelConfig["onText"]>;
}): RouteHandler<TwilioChannelState> {
  return async (req, { send, waitUntil }) => {
    const verified = await verifyTwilioInbound(req, input.config);
    if (verified === null) return new Response("unauthorized", { status: 401 });

    const message = parseTwilioTextMessage(verified.params);
    if (!message) return emptyTwilioResponse();
    if (!(await isAllowed(message.from, input.config.allowFrom))) {
      return new Response("forbidden", { status: 403 });
    }

    waitUntil(
      dispatchText({
        config: input.config,
        message,
        onText: input.onText,
        send,
      }),
    );
    return emptyTwilioResponse();
  };
}

function handleTwilioVoice(input: {
  readonly config: TwilioChannelConfig;
  readonly onVoice: NonNullable<TwilioChannelConfig["onVoice"]>;
  readonly routes: TwilioRoutes;
}): RouteHandler<TwilioChannelState> {
  return async (req) => {
    const verified = await verifyTwilioInbound(req, input.config);
    if (verified === null) return new Response("unauthorized", { status: 401 });

    const call = parseTwilioVoiceCall(verified.params);
    if (!call) return sayTwilioResponse("Missing caller information.");
    if (!(await isAllowed(call.from, input.config.allowFrom))) {
      return new Response("forbidden", { status: 403 });
    }

    const voiceResult = await acceptVoiceCall({
      call,
      config: input.config,
      onVoice: input.onVoice,
    });
    if (voiceResult === null) return new Response("forbidden", { status: 403 });
    const voiceOptions = voiceResult ?? {};

    return gatherSpeechTwilioResponse({
      actionUrl: await buildTwilioActionUrl(req, input.config, input.routes.transcription),
      hints: voiceOptions.hints ?? input.config.voice?.hints,
      language: voiceOptions.language ?? input.config.voice?.language,
      profanityFilter: voiceOptions.profanityFilter ?? input.config.voice?.profanityFilter,
      prompt:
        voiceOptions.prompt ??
        input.config.voice?.prompt ??
        "Please say your message after the tone.",
      speechModel: voiceOptions.speechModel ?? input.config.voice?.speechModel,
      speechTimeout: voiceOptions.speechTimeout ?? input.config.voice?.speechTimeout ?? "auto",
      timeoutSeconds: voiceOptions.timeoutSeconds ?? input.config.voice?.timeoutSeconds,
      voice: voiceOptions.voice ?? input.config.voice?.voice,
    });
  };
}

function handleTwilioTranscription(input: {
  readonly config: TwilioChannelConfig;
  readonly onVoiceTranscription: NonNullable<TwilioChannelConfig["onVoiceTranscription"]>;
  readonly routes: TwilioRoutes;
}): RouteHandler<TwilioChannelState> {
  return async (req, { send, waitUntil }) => {
    const verified = await verifyTwilioInbound(req, input.config);
    if (verified === null) return new Response("unauthorized", { status: 401 });

    const transcription = parseTwilioVoiceTranscription(verified.params);
    if (!transcription) {
      return gatherSpeechTwilioResponse({
        actionUrl: await buildTwilioActionUrl(req, input.config, input.routes.transcription),
        language: input.config.voice?.language,
        prompt: input.config.voice?.prompt ?? "Please say your message after the tone.",
        speechTimeout: input.config.voice?.speechTimeout ?? "auto",
        timeoutSeconds: input.config.voice?.timeoutSeconds,
      });
    }
    if (!(await isAllowed(transcription.from, input.config.allowFrom))) {
      return new Response("forbidden", { status: 403 });
    }

    waitUntil(
      dispatchVoiceTranscription({
        config: input.config,
        onVoiceTranscription: input.onVoiceTranscription,
        send,
        transcription,
      }),
    );
    return sayTwilioResponse(
      input.config.voice?.acknowledgement ?? "Thanks. I'll follow up by text.",
    );
  };
}

function rebuildTwilioContext(
  state: TwilioChannelState,
  _session: SessionHandle,
  config: TwilioChannelConfig,
): TwilioChannelContext {
  return {
    state,
    twilio: buildTwilioHandle({
      callSid: state.lastCallSid ?? undefined,
      config,
      from: state.from ?? "",
      to: state.to ?? undefined,
    }),
  };
}

function buildTwilioHandle(input: {
  readonly callSid: string | undefined;
  readonly config: TwilioChannelConfig;
  readonly from: string;
  readonly to: string | undefined;
}): TwilioHandle {
  const api = input.config.api;
  const credentials = input.config.credentials;
  const defaultFrom = input.config.messaging?.from ?? input.to;
  const defaultMessagingServiceSid = input.config.messaging?.messagingServiceSid;
  const defaultStatusCallbackUrl = input.config.messaging?.statusCallbackUrl;

  return {
    callSid: input.callSid,
    from: input.from,
    to: input.to,
    request(path, body) {
      return callTwilioApi({
        apiBaseUrl: api?.apiBaseUrl,
        body,
        credentials,
        fetch: api?.fetch,
        path,
      });
    },
    sendMessage(message, options) {
      return sendTwilioMessage({
        apiBaseUrl: api?.apiBaseUrl,
        body: message,
        credentials,
        fetch: api?.fetch,
        from: options?.from ?? defaultFrom,
        messagingServiceSid: options?.messagingServiceSid ?? defaultMessagingServiceSid,
        statusCallbackUrl: options?.statusCallbackUrl ?? defaultStatusCallbackUrl,
        to: options?.to ?? input.from,
      });
    },
    updateCall(callSid, twiml) {
      return updateTwilioCall({
        apiBaseUrl: api?.apiBaseUrl,
        callSid,
        credentials,
        fetch: api?.fetch,
        twiml,
      });
    },
  };
}

function assertAllowFromConfigured(
  config: TwilioChannelConfig | undefined,
): asserts config is TwilioChannelConfig {
  if (config?.allowFrom === undefined) {
    throw new Error('twilioChannel requires allowFrom. Use allowFrom: "*" to allow all numbers.');
  }
}

async function dispatchText(input: {
  readonly config: TwilioChannelConfig;
  readonly message: TwilioTextMessage;
  readonly onText: NonNullable<TwilioChannelConfig["onText"]>;
  readonly send: SendFn<TwilioChannelState>;
}): Promise<void> {
  const { message } = input;
  const twilio: TwilioContext = {
    twilio: buildTwilioHandle({
      callSid: undefined,
      config: input.config,
      from: message.from,
      to: message.to,
    }),
  };

  let result: TwilioInboundResult;
  try {
    result = await input.onText(twilio, message);
  } catch (error) {
    log.error("text handler failed", { error });
    return;
  }
  if (result === null || result === undefined) return;

  const contextBlock = formatTwilioContextBlock({
    channel: "text",
    from: message.from,
    messageSid: message.messageSid,
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
        continuationToken: twilioContinuationToken(message.from, message.to),
        state: {
          from: message.from,
          lastCallSid: null,
          lastMessageSid: message.messageSid ?? null,
          to: message.to ?? null,
        },
      },
    );
  } catch (error) {
    log.error("text delivery failed", { error });
  }
}

async function acceptVoiceCall(input: {
  readonly call: TwilioVoiceCall;
  readonly config: TwilioChannelConfig;
  readonly onVoice: NonNullable<TwilioChannelConfig["onVoice"]>;
}): Promise<TwilioVoiceResult | null | undefined> {
  const { call } = input;
  const twilio: TwilioContext = {
    twilio: buildTwilioHandle({
      callSid: call.callSid,
      config: input.config,
      from: call.from,
      to: call.to,
    }),
  };

  try {
    return await input.onVoice(twilio, call);
  } catch (error) {
    log.error("voice handler failed", { error });
    return null;
  }
}

async function dispatchVoiceTranscription(input: {
  readonly config: TwilioChannelConfig;
  readonly onVoiceTranscription: NonNullable<TwilioChannelConfig["onVoiceTranscription"]>;
  readonly send: SendFn<TwilioChannelState>;
  readonly transcription: TwilioVoiceTranscription;
}): Promise<void> {
  const { transcription } = input;
  const twilio: TwilioContext = {
    twilio: buildTwilioHandle({
      callSid: transcription.callSid,
      config: input.config,
      from: transcription.from,
      to: transcription.to,
    }),
  };

  let result: TwilioInboundResult;
  try {
    result = await input.onVoiceTranscription(twilio, transcription);
  } catch (error) {
    log.error("voice transcription handler failed", { error });
    return;
  }
  if (result === null || result === undefined) return;

  const contextBlock = formatTwilioContextBlock({
    callSid: transcription.callSid,
    channel: "voice",
    from: transcription.from,
    to: transcription.to,
  });

  try {
    await input.send(
      {
        message: transcription.text,
        context: [contextBlock],
      },
      {
        auth: result.auth,
        continuationToken: twilioContinuationToken(transcription.from, transcription.to),
        state: {
          from: transcription.from,
          lastCallSid: transcription.callSid ?? null,
          lastMessageSid: null,
          to: transcription.to ?? null,
        },
      },
    );
  } catch (error) {
    log.error("voice transcription delivery failed", { error });
  }
}

async function isAllowed(from: string, allowFrom: TwilioAllowFrom): Promise<boolean> {
  const resolved = typeof allowFrom === "function" ? await allowFrom() : allowFrom;
  if (resolved === "*") return true;
  return typeof resolved === "string" ? resolved === from : resolved.includes(from);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
