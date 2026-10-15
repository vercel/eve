import type { ChannelFrom } from "#channel/channel-operations.js";
import type { PromptQueueState } from "#channel/prompt-queue.js";
import type { RouteHandler } from "#channel/routes.js";
import type { SessionAuthContext, TurnPolicy } from "#channel/types.js";
import { defaultDeliverResult } from "#channel/adapter.js";
import { attachInputText } from "#internal/input-text.js";
import { createLogger } from "#internal/logging.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { SessionContext } from "#public/definitions/callback-context.js";
import {
  type Channel,
  type ChannelContinuationOps,
  defineChannel,
  POST,
} from "#public/definitions/channel.js";
import {
  callRecallApi,
  createRecallBot,
  leaveRecallCall,
  outputRecallAudio,
  recallBotConfig,
  recallSupportsDirectMessages,
  sendRecallChatMessage,
  startRecallOutputMedia,
  stopRecallOutputMedia,
  type RecallApiOptions,
} from "#public/channels/recall/api.js";
import {
  defaultEvents,
  defaultOnMeetingEvent,
  defaultShouldRespond,
  isAddressedTo,
} from "#public/channels/recall/defaults.js";
import { parseRecallEvent, type RecallMeetingEvent } from "#public/channels/recall/inbound.js";
import {
  resolveRecallVerificationSecret,
  verifyRecallWebhook,
} from "#public/channels/recall/verify.js";

const log = createLogger("recall.channel");

/** Real-time payloads are one utterance or chat message; anything near this is not Recall. */
const MAX_WEBHOOK_BYTES = 256 * 1024;

/** How many lines the agent didn't answer stay in state for the next turn it takes. */
const MAX_TRANSCRIPT_LINES = 60;

type EventData<T extends UnstampedMessageStreamEvent["type"]> =
  Extract<UnstampedMessageStreamEvent, { type: T }> extends { data: infer D } ? D : undefined;

/** JSON-serializable state for one bot's meeting session. */
export interface RecallChannelState extends PromptQueueState {
  botId: string | null;
  /** Meeting platform, such as `zoom`, learned from the first participant event. */
  platform: string | null;
  /** Lines the agent heard but didn't answer since its last turn, oldest first. */
  transcript?: string[];
}

/** Per-delivery state: the event a line came from, which `deliver` reads and doesn't keep. */
interface RecallDeliveryState extends RecallChannelState {
  event?: RecallMeetingEvent;
}

/** Input to {@link RecallChannelConfig.shouldRespond}. */
export interface RecallRespondInput {
  readonly event: RecallMeetingEvent;
  /** The line the model will see for this event, such as `Alice: can you file that?`. */
  readonly line: string;
  /** Lines the agent heard but didn't answer since its last turn, oldest first. */
  readonly transcript: readonly string[];
  readonly botName: string;
}

/** Credentials for the Recall API and webhook verification. */
export interface RecallChannelCredentials {
  /** Defaults to `RECALL_API_KEY`. */
  readonly apiKey?: string;
  /** Workspace verification secret (`whsec_…`). Defaults to `RECALL_WORKSPACE_VERIFICATION_SECRET`. */
  readonly verificationSecret?: string;
}

/** Low-level handle on the meeting's bot, exposed to hooks and event handlers. */
export interface RecallHandle {
  readonly botId: string;
  /** Meeting platform, when known. */
  readonly platform: string | undefined;
  /** Whether {@link sendChatMessage} can reach one participant. Only Zoom supports it. */
  readonly supportsDirectMessages: boolean;
  /**
   * Posts to the meeting chat, split to fit the platform's limit. Returns
   * `false` instead of throwing when Recall rejects it, such as after the bot
   * left the call.
   */
  sendChatMessage(message: string, options?: { readonly to?: string }): Promise<boolean>;
  /** Plays an MP3 clip through the bot. The bot must be created with `automatic_audio_output`. */
  outputAudio(mp3: Uint8Array): Promise<void>;
  /** Streams a web page into the meeting as the bot's camera and microphone (Recall Output Media). */
  startOutputMedia(url: string): Promise<void>;
  stopOutputMedia(): Promise<void>;
  /** Removes the bot from the meeting. */
  leaveCall(): Promise<void>;
  /** Raw Recall REST escape hatch. `path` is relative to `/api/v1`. */
  request<T = unknown>(
    path: string,
    init?: { readonly method?: "GET" | "POST" | "DELETE" | "PATCH"; readonly body?: unknown },
  ): Promise<T>;
}

/** Context passed to {@link RecallChannelConfig.onMeetingEvent}. */
export interface RecallContext {
  readonly recall: RecallHandle;
  /** The configured bot name, for addressing checks. */
  readonly botName: string;
}

/** Channel context for event handlers. */
interface RecallChannelContext {
  readonly recall: RecallHandle;
  state: RecallChannelState;
}

/** Event-handler Recall context, including continuation routing. */
export interface RecallEventContext extends RecallChannelContext, ChannelContinuationOps {}

/**
 * Result of {@link RecallChannelConfig.onMeetingEvent}. Return `null` to drop
 * the event; otherwise supply the session `auth`, and optionally the message
 * the model sees in place of the default speaker-prefixed line.
 */
export type RecallInboundResult = {
  readonly auth: SessionAuthContext | null;
  readonly message?: string;
  readonly title?: string;
} | null;

/** Sync or async {@link RecallInboundResult}. */
export type RecallInboundResultOrPromise =
  | RecallInboundResult
  | undefined
  | Promise<RecallInboundResult | undefined>;

type RecallEventHandler<T extends UnstampedMessageStreamEvent["type"]> = (
  data: EventData<T>,
  channel: RecallEventContext,
  ctx: SessionContext,
) => void | Promise<void>;

/** Event handlers supported by `recallChannel({ events })`. */
export interface RecallChannelEvents {
  readonly "turn.started"?: RecallEventHandler<"turn.started">;
  readonly "actions.requested"?: RecallEventHandler<"actions.requested">;
  readonly "action.result"?: RecallEventHandler<"action.result">;
  readonly "message.completed"?: RecallEventHandler<"message.completed">;
  readonly "input.requested"?: RecallEventHandler<"input.requested">;
  readonly "input.resolved"?: RecallEventHandler<"input.resolved">;
  readonly "approval.settled"?: RecallEventHandler<"approval.settled">;
  readonly "turn.failed"?: RecallEventHandler<"turn.failed">;
  readonly "turn.completed"?: RecallEventHandler<"turn.completed">;
  readonly "session.failed"?: (
    data: EventData<"session.failed">,
    channel: RecallEventContext,
  ) => void | Promise<void>;
  readonly "session.completed"?: RecallEventHandler<"session.completed">;
  readonly "authorization.required"?: RecallEventHandler<"authorization.required">;
  readonly "authorization.completed"?: RecallEventHandler<"authorization.completed">;
}

/** Target accepted by `receive(recall, { target })`: sends a new bot to a meeting. */
export interface RecallReceiveTarget {
  readonly meetingUrl: string;
  /** Metadata Recall echoes on every webhook for the bot. */
  readonly metadata?: Readonly<Record<string, string>>;
}

/** Configuration for {@link recallChannel}. */
export interface RecallChannelConfig {
  readonly credentials?: RecallChannelCredentials;
  /** Recall workspace region. Defaults to `RECALL_REGION`, then `us-east-1`. */
  readonly region?: string;
  /** Webhook route for real-time and bot status events. Defaults to `/eve/v1/recall`. */
  readonly route?: string;
  /**
   * The bot's display name. Default speech handling answers utterances that
   * name it, and chat from a participant with this name is the bot's own.
   * Defaults to `eve`.
   */
  readonly botName?: string;
  /**
   * Public URL of the webhook route, for bots `receive` creates. Defaults to
   * the route on `VERCEL_PROJECT_PRODUCTION_URL`.
   */
  readonly webhookUrl?: string;
  /**
   * Policy for messages that arrive while a turn is active. Defaults to
   * `"queue"`: people keep talking while the agent works, and steering would
   * restart it on every utterance.
   */
  readonly turnPolicy?: TurnPolicy;
  readonly api?: Pick<RecallApiOptions, "apiBaseUrl" | "fetch">;
  /**
   * Decides which meeting events reach the session and as whom. Runs in the
   * webhook route, before the session. Defaults to speech, chat, joins, and
   * leaves, each as its participant. See `recallParticipantAuth` and
   * `recallMeetingAuth`. Use `shouldRespond` to decide which of them get an
   * answer.
   */
  onMeetingEvent?(ctx: RecallContext, event: RecallMeetingEvent): RecallInboundResultOrPromise;
  /**
   * Decides whether a line the session heard starts a turn. Lines it declines
   * cost no model call: they're kept and given to the next turn as recent
   * transcript, and they don't withdraw a pending approval or question.
   * Runs inside the session, so it sees the recent transcript; call a fast
   * decision model such as `decide` from `eve/ai` here. Defaults to every chat
   * message and speech that names the bot. A throw falls back to the default.
   */
  shouldRespond?(input: RecallRespondInput): boolean | Promise<boolean>;
  readonly events?: RecallChannelEvents;
}

/** Concrete return type of {@link recallChannel}. */
export interface RecallChannel extends Channel<RecallChannelState, RecallReceiveTarget> {}

/**
 * Recall.ai meeting bot channel: each bot's meeting is one session. Speech and
 * chat arrive through Recall's real-time webhooks, and replies go to the
 * meeting chat.
 */
export function recallChannel(config: RecallChannelConfig = {}): RecallChannel {
  const route = config.route ?? "/eve/v1/recall";
  const botName = config.botName ?? "eve";
  const onMeetingEvent = config.onMeetingEvent ?? defaultOnMeetingEvent;
  const shouldRespond = async (input: RecallRespondInput): Promise<boolean> => {
    if (config.shouldRespond === undefined) return defaultShouldRespond(input);
    try {
      return await config.shouldRespond(input);
    } catch (error) {
      log.warn("shouldRespond failed; falling back to name matching", { error });
      return defaultShouldRespond(input);
    }
  };
  const api: RecallApiOptions = {
    ...config.api,
    apiKey: config.credentials?.apiKey,
    region: config.region,
  };

  return defineChannel<RecallChannelState, RecallChannelContext, RecallReceiveTarget>({
    kindHint: "recall",
    turnPolicy: config.turnPolicy ?? "queue",
    state: { botId: null, platform: null },
    audience: () => "unknown",
    metadata: (state) => ({ botId: state.botId, platform: state.platform }),

    context(state) {
      return { recall: buildRecallHandle(api, state), state };
    },

    async deliver(payload, channel) {
      const delivered = payload.state as Partial<RecallDeliveryState> | undefined;
      if (delivered?.platform) channel.state.platform = delivered.platform;
      // A session's first send seeds state with the whole delivery.
      delete (channel.state as RecallDeliveryState).event;
      const event = delivered?.event;
      if (event === undefined || typeof payload.message !== "string") {
        return defaultDeliverResult(payload);
      }

      const transcript = channel.state.transcript ?? [];
      const line = payload.message;
      if (!(await shouldRespond({ botName, event, line, transcript }))) {
        // Between turns the session parks without a model call; during a held
        // turn eve ignores the delivery, so a pending prompt stays open.
        channel.state.transcript = [...transcript, line].slice(-MAX_TRANSCRIPT_LINES);
        return undefined;
      }
      channel.state.transcript = [];
      const input = defaultDeliverResult(payload);
      if (input === undefined || transcript.length === 0) return input;
      return { ...input, context: [...(input.context ?? []), formatTranscript(transcript)] };
    },

    routes: [
      POST<RecallChannelState>(route, handleWebhook({ api, botName, config, onMeetingEvent })),
    ],

    async receive(input, { from }) {
      const webhookUrl = resolveWebhookUrl(config.webhookUrl, route);
      const bot = await createRecallBot({
        ...api,
        body: recallBotConfig({
          botName,
          meetingUrl: input.target.meetingUrl,
          metadata: input.target.metadata,
          webhookUrl,
        }),
      });
      return await from(bot.id).send(input.message, {
        auth: input.auth,
        state: { botId: bot.id, platform: null },
      });
    },

    events: { ...defaultEvents, ...config.events },
  });
}

function handleWebhook(input: {
  readonly api: RecallApiOptions;
  readonly botName: string;
  readonly config: RecallChannelConfig;
  readonly onMeetingEvent: NonNullable<RecallChannelConfig["onMeetingEvent"]>;
}): RouteHandler<RecallChannelState> {
  return async (request, { from, waitUntil }) => {
    let secret: string;
    try {
      secret = resolveRecallVerificationSecret(input.config.credentials?.verificationSecret);
    } catch (error) {
      log.error("webhook verification is not configured", { error });
      return new Response("Recall webhook verification is not configured.", { status: 503 });
    }
    const payload = await readBoundedText(request, MAX_WEBHOOK_BYTES);
    if (payload === undefined) return new Response("payload too large", { status: 413 });
    if (!verifyRecallWebhook({ headers: request.headers, payload, secret })) {
      return new Response("unauthorized", { status: 401 });
    }

    let event: RecallMeetingEvent | null;
    try {
      event = parseRecallEvent(JSON.parse(payload));
    } catch {
      // Recall retries non-2xx every second, so a body we can't read is acknowledged and dropped.
      log.warn("dropping unparseable Recall webhook");
      return new Response(null, { status: 204 });
    }
    if (event === null || isOwnMessage(event, input.botName)) {
      return new Response(null, { status: 204 });
    }

    // Acknowledge first: Recall retries anything slower than its timeout.
    waitUntil(dispatch({ ...input, event, from }));
    return new Response(null, { status: 204 });
  };
}

async function dispatch(input: {
  readonly api: RecallApiOptions;
  readonly botName: string;
  readonly event: RecallMeetingEvent;
  readonly from: ChannelFrom<RecallDeliveryState>;
  readonly onMeetingEvent: NonNullable<RecallChannelConfig["onMeetingEvent"]>;
}): Promise<void> {
  const { event } = input;
  const platform = "participant" in event ? (event.participant.platform ?? null) : null;
  const ctx: RecallContext = {
    botName: input.botName,
    recall: buildRecallHandle(input.api, { botId: event.botId, platform }),
  };

  let result: RecallInboundResult | undefined;
  try {
    result = await input.onMeetingEvent(ctx, event);
  } catch (error) {
    log.error("onMeetingEvent failed", { error });
    return;
  }
  if (result === null || result === undefined) return;

  try {
    await input.from(event.botId).send(
      result.message ?? formatMeetingEvent(event),
      attachInputText(
        {
          auth: result.auth,
          context: [formatRecallContextBlock(event, platform)],
          state: { botId: event.botId, event, platform },
          title: result.title,
        },
        // The speaker prefix stays model-visible; a pending prompt matches what they said.
        answerTextOf(event, input.botName),
      ),
    );
  } catch (error) {
    log.error("Recall delivery failed", { error });
  }
}

/** The line the model sees for one meeting event. */
export function formatMeetingEvent(event: RecallMeetingEvent): string {
  switch (event.type) {
    case "speech":
      return `${event.participant.name}: ${event.text}`;
    case "chat":
      // Chat can span lines, so the attribution gets its own.
      return `${event.participant.name} (${event.to === "only_bot" ? "privately " : ""}in chat):\n${event.text}`;
    case "join":
      return `${event.participant.name} joined the meeting.`;
    case "leave":
      return `${event.participant.name} left the meeting.`;
    case "status":
      return event.status === "call_ended" || event.status === "done"
        ? "The meeting ended. You can no longer post to its chat."
        : `The meeting bot's status changed to ${event.status}.`;
  }
}

/**
 * The words a pending prompt resolves against. Speech drops the bot's name
 * and the punctuation transcription adds, so "Eve, approve." answers as
 * "approve".
 */
function answerTextOf(event: RecallMeetingEvent, botName: string): string | undefined {
  if (event.type === "chat") return event.text;
  if (event.type !== "speech") return undefined;
  let text = event.text;
  if (isAddressedTo(text, botName)) {
    text = text.replace(new RegExp(`^\\W*${escapeRegExp(botName)}\\W*`, "iu"), "");
  }
  return text.replace(/[.!?,;:]+$/u, "").trim();
}

function formatTranscript(lines: readonly string[]): string {
  return [
    "<meeting_transcript>",
    "What was said since your last turn, which you heard but didn't answer:",
    ...lines,
    "</meeting_transcript>",
  ].join("\n");
}

function formatRecallContextBlock(event: RecallMeetingEvent, platform: string | null): string {
  const lines = [
    "<recall_context>",
    "channel: meeting",
    ...(platform ? [`platform: ${platform}`] : []),
    `bot_id: ${event.botId}`,
    "response_medium: meeting chat",
    "response_instructions: Your replies are posted to the meeting chat as plain text. Keep them short and skip markdown. Lines are transcribed speech or chat, prefixed with the participant's display name, which is not verified.",
    ...("participant" in event
      ? [
          `participant_id: ${event.participant.id}`,
          `participant_name: ${event.participant.name}`,
          ...(event.participant.isHost ? ["participant_is_host: true"] : []),
        ]
      : []),
    "</recall_context>",
  ];
  return lines.join("\n");
}

function isOwnMessage(event: RecallMeetingEvent, botName: string): boolean {
  return event.type === "chat" && event.participant.name === botName;
}

function buildRecallHandle(
  api: RecallApiOptions,
  state: Pick<RecallChannelState, "botId" | "platform">,
): RecallHandle {
  const botId = (): string => {
    if (!state.botId) throw new Error("recallChannel: this session has no Recall bot.");
    return state.botId;
  };
  return {
    get botId() {
      return botId();
    },
    get platform() {
      return state.platform ?? undefined;
    },
    get supportsDirectMessages() {
      return recallSupportsDirectMessages(state.platform ?? undefined);
    },
    async sendChatMessage(message, options) {
      try {
        await sendRecallChatMessage({
          ...api,
          botId: botId(),
          message,
          platform: state.platform ?? undefined,
          to: options?.to,
        });
        return true;
      } catch (error) {
        log.error("Recall chat message failed", { error });
        return false;
      }
    },
    outputAudio: (mp3) => outputRecallAudio({ ...api, botId: botId(), mp3 }),
    startOutputMedia: (url) => startRecallOutputMedia({ ...api, botId: botId(), url }),
    stopOutputMedia: () => stopRecallOutputMedia({ ...api, botId: botId() }),
    leaveCall: () => leaveRecallCall({ ...api, botId: botId() }),
    request: (path, init) => callRecallApi({ ...api, ...init, path }),
  };
}

function resolveWebhookUrl(explicit: string | undefined, route: string): string {
  if (explicit) return explicit;
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (host) return new URL(route, `https://${host}`).toString();
  throw new Error(
    "recallChannel: set webhookUrl to the public HTTPS URL of the Recall route, such as a tunnel to `eve dev`, so Recall can reach the bot.",
  );
}

async function readBoundedText(request: Request, maxBytes: number): Promise<string | undefined> {
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) return undefined;
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
