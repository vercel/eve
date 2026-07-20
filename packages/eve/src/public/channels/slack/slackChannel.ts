import { parseSlackWebhookBody } from "#compiled/@chat-adapter/slack/webhook.js";

import type { SessionHandle } from "#channel/session.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { CardElement } from "#compiled/chat/index.js";
import type { SessionContext } from "#public/definitions/callback-context.js";
import type { ChannelSessionOps } from "#public/definitions/channel.js";

import { createLogger, logError } from "#internal/logging.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import {
  buildSlackBinding,
  slackContinuationToken,
  type SlackBotToken,
  type SlackHandle,
  type SlackThread,
} from "#public/channels/slack/api.js";
import {
  buildSlackTurnMessage,
  collectInboundFileParts,
  createSlackFetchFile,
} from "#public/channels/slack/attachments.js";
import {
  defaultEvents,
  defaultInputRequestedHandler,
  defaultOnAppMention,
  defaultOnDirectMessage,
} from "#public/channels/slack/defaults.js";
import {
  type SlackInboundContext,
  type SlackMessage,
  slackMessageFromWebhookPayload,
} from "#public/channels/slack/inbound.js";
import {
  formatSlackInboundMessage,
  formatSlackThreadContext,
} from "#public/channels/slack/model-context.js";
import {
  loadThreadContextMessages,
  type LoadThreadContextMessagesOptions,
} from "#public/channels/slack/thread.js";
import { slackUserIdFromAuthContext } from "#public/channels/slack/auth.js";
import { SLACK_CHANNEL_DEFAULT_ROUTE } from "#public/channels/slack/constants.js";
import { handleInteractionPost } from "#public/channels/slack/interactions.js";
import {
  mergeUploadPolicy,
  type UploadPolicy,
  type UploadPolicyInput,
} from "#public/channels/upload-policy.js";
import { verifySlackRequest, type SlackWebhookVerifier } from "#public/channels/slack/verify.js";
import { defineChannel, POST, type Channel, type SendFn } from "#public/definitions/channel.js";
import { markEventHandled } from "./utils.js";

const log = createLogger("slack.channel");

type EventData<T extends HandleMessageStreamEvent["type"]> =
  Extract<HandleMessageStreamEvent, { type: T }> extends { data: infer D } ? D : undefined;

/**
 * Pre-dispatch Slack context passed to `onAppMention` and
 * `onInteraction`. These hooks run on the inbound webhook side before the
 * runtime hydrates session state, so `state` is absent here.
 * {@link thread} owns thread-scoped operations (`post`, `postEphemeral`,
 * `startTyping`, `refresh`, `recentMessages`, `mentionUser`); {@link slack}
 * owns Slack identity (`channelId`, `threadTs`, `teamId`) plus the raw-API
 * escape hatch (`request`, `uploadFiles`).
 */
export interface SlackContext {
  readonly thread: SlackThread;
  readonly slack: SlackHandle;
}

/**
 * {@link SlackContext} plus the persisted per-session
 * {@link SlackChannelState}. Built by the channel's `context()` hook and
 * extended by {@link SlackEventContext}.
 */
export interface SlackChannelContext extends SlackContext {
  state: SlackChannelState;
}

/**
 * Slack context handed to `events[type]` handlers. Extends
 * {@link SlackChannelContext} (`thread`, `slack`, hydrated `state`) with
 * session operations ({@link ChannelSessionOps}). Unlike the pre-dispatch
 * {@link SlackContext}, `state` is hydrated here.
 */
export interface SlackEventContext extends SlackChannelContext, ChannelSessionOps {}

export type {
  SlackApiResponse,
  SlackBotToken,
  SlackHandle,
  SlackThread,
} from "#public/channels/slack/api.js";
export type { SlackWebhookVerifier } from "#public/channels/slack/verify.js";

type SlackEventHandler<T extends HandleMessageStreamEvent["type"]> = (
  data: EventData<T>,
  channel: SlackEventContext,
  ctx: SessionContext,
) => void | Promise<void>;

/**
 * Delivery surface handed to `authorization.required` overrides. The
 * connection challenge is a credential: anyone who completes the sign-in
 * binds their identity to this session's connection. So the only
 * delivery capabilities here are private ones, an ephemeral reply in the
 * thread or a direct message. There is deliberately no public `post`,
 * no raw `slack.request` escape hatch, and no full thread handle. An
 * override can change the words, not the audience.
 */
export interface SlackAuthorizationEventContext {
  /**
   * Ephemeral message in the current thread, visible only to `userId`.
   * Same contract as {@link SlackThread.postEphemeral}.
   */
  readonly postEphemeral: SlackThread["postEphemeral"];
  /**
   * Direct message to `userId`'s IM conversation with the bot. Same
   * contract as {@link SlackThread.postDirectMessage} (requires the
   * `im:write` scope).
   */
  readonly postDirectMessage: SlackThread["postDirectMessage"];
  /**
   * Hydrated per-session channel state — read `triggeringUserId` to
   * target the delivery.
   */
  readonly state: SlackChannelState;
}

/**
 * Signature of an `authorization.required` override. Unlike every other
 * event handler, it receives {@link SlackAuthorizationEventContext}
 * instead of the full {@link SlackEventContext} — see the context type
 * for why.
 */
export type SlackAuthorizationRequiredHandler = (
  data: EventData<"authorization.required">,
  channel: SlackAuthorizationEventContext,
  ctx: SessionContext,
) => void | Promise<void>;

type SlackSessionFailedHandler = (
  data: EventData<"session.failed">,
  channel: SlackEventContext,
) => void | Promise<void>;

/**
 * JSON-serializable per-session state, stored verbatim across workflow
 * step boundaries. Anything written here must round-trip through
 * `JSON.stringify` / `JSON.parse`.
 */
export interface SlackChannelState {
  /** Slack channel id seeded by the inbound mention. */
  channelId: string | null;
  /** Slack thread root ts. */
  threadTs: string | null;
  /** Slack team id, when the inbound event carried one. */
  teamId: string | null;
  /**
   * Slack user id of the actor that triggered the current session/turn.
   * Captured on every inbound mention so default handlers (e.g.
   * `authorization.required`) can target ephemeral feedback at the right
   * user without re-parsing the mention payload.
   */
  triggeringUserId?: string | null;
  /**
   * Buffered text from a `message.completed` event whose `finishReason`
   * was `"tool-calls"`. The default `actions.requested` handler uses the
   * first non-empty line as the next typing indicator, surfacing the
   * model's pre-tool narration instead of the action label. Cleared at
   * `turn.started` and after use.
   */
  pendingToolCallMessage?: string | null;
  /**
   * Last reasoning-derived typing indicator sent by the default
   * `reasoning.appended` handler. Used to surface substantial progressive
   * extensions immediately while throttling smaller streamed deltas.
   */
  lastReasoningTypingAtMs?: number | null;
  lastReasoningTypingStatus?: string | null;
  /**
   * Connection name to Slack message ts. Each entry is the public
   * link-free status post created by the default
   * `authorization.required` handler; the matching
   * `authorization.completed` handler edits it in place to surface the
   * resolution outcome.
   */
  pendingAuthMessageTs?: Record<string, string>;
}

/**
 * Per-session metadata attached to tracing spans, projected by the
 * channel's `metadata(state)` hook. Fields mirror the inbound mention
 * (channel, team, thread, triggering user) and are `null` until an inbound
 * event seeds them. Open-ended (`Record<string, unknown>`) so deployments
 * can attach extra span attributes.
 */
export interface SlackInstrumentationMetadata extends Record<string, unknown> {
  readonly channelId: string | null;
  readonly teamId: string | null;
  readonly threadTs: string | null;
  readonly triggeringUserId: string | null;
}

/**
 * Slack channel credentials: outbound bot token plus inbound webhook
 * verification. Any field may be omitted to fall back to its env-var /
 * signing-secret default.
 */
export interface SlackChannelCredentials {
  /**
   * Bot token for all outbound Slack Web API calls. Falls back to
   * `process.env.SLACK_BOT_TOKEN` when omitted.
   */
  readonly botToken?: SlackBotToken;
  /**
   * Signing secret used to HMAC-verify inbound webhook requests. Falls
   * back to `process.env.SLACK_SIGNING_SECRET` when neither this nor
   * `webhookVerifier` is supplied.
   */
  readonly signingSecret?: string;
  /**
   * Custom inbound webhook verifier. When supplied, eve skips the
   * `SLACK_SIGNING_SECRET` fallback and delegates to it. Typically set by
   * integrations (e.g. Connect) that authenticate webhooks out-of-band.
   */
  readonly webhookVerifier?: SlackWebhookVerifier;
}

/** Target accepted by `receive(slack, { target })` for proactive sessions. */
export interface SlackReceiveTarget {
  readonly channelId: string;
  readonly threadTs?: string;
  /**
   * Optional message posted into the Slack channel before the agent runs.
   * The post becomes the thread root and the first turn is threaded under
   * it, giving cross-channel handoffs a visible context anchor. Mutually
   * exclusive with {@link threadTs}.
   */
  readonly initialMessage?: SlackInitialMessage;
}

/**
 * Pre-agent post issued by `slackChannel().receive` when the caller
 * provides `target.initialMessage`. Mirrors `ctx.thread.post`'s card
 * variant so the same `Card({...})` construction can be reused.
 */
export interface SlackInitialMessage {
  readonly card: CardElement;
  readonly fallbackText?: string;
}

export interface SlackInteractionAction {
  readonly actionId: string;
  readonly value?: string;
  readonly blockId?: string;
  /**
   * `selected_option.value` for radio / select / external_select
   * widgets. `undefined` for buttons and multi-select widgets.
   */
  readonly selectedOptionValue?: string;
  /**
   * `ts` of the Slack message hosting the clicked component. Required to
   * update that message in place via `chat.update`, since `ctx.slack.threadTs`
   * resolves to the thread root (not the clicked message) for components
   * inside thread replies.
   */
  readonly messageTs?: string;
  /**
   * Display label of the clicked widget: `text.text` for buttons,
   * `selected_option.text.text` for radio/static_select. Renders the
   * "answered" card without re-fetching the original request.
   */
  readonly label?: string;
  /**
   * Slack actor who triggered the interaction, letting `onInteraction`
   * handlers attribute resolutions back to the clicker without re-parsing
   * the raw payload. Always present, since Slack requires `user` on every
   * `block_actions` payload.
   */
  readonly user: SlackInteractionUser;
}

/** Slack actor on {@link SlackInteractionAction.user}, mirroring `body.user`. */
export interface SlackInteractionUser {
  readonly id: string;
  /** Modern canonical display handle. */
  readonly username?: string;
  /** Legacy display handle, kept for older workspaces. */
  readonly name?: string;
}

/**
 * Result of an `onAppMention` or `onDirectMessage` callback. Return an
 * object (auth may be `null`) to dispatch a turn, or `null` to drop the
 * inbound message. `context` strings are appended as user messages to
 * session history before the delivery message.
 */
export type SlackMentionResult = {
  readonly auth: SessionAuthContext | null;
  readonly context?: readonly string[];
} | null;

export type SlackMentionResultOrPromise = SlackMentionResult | Promise<SlackMentionResult>;

/**
 * Alias of {@link SlackMentionResult} for the `onDirectMessage` signature,
 * so DM handlers do not read in terms of "mention".
 */
export type SlackInboundResult = SlackMentionResult;

/** {@link SlackInboundResult}, or a promise resolving to one. */
export type SlackInboundResultOrPromise = SlackMentionResultOrPromise;

/**
 * Per-event Slack handlers keyed by harness stream-event type, passed to
 * `slackChannel({ events })`. Each key is optional; supplying one replaces
 * only that event's built-in default (see {@link defaultEvents}). Handlers
 * receive the event data, the {@link SlackEventContext}, and the session
 * {@link SessionContext}; `session.failed` receives only data and context.
 */
export interface SlackChannelEvents {
  readonly "turn.started"?: SlackEventHandler<"turn.started">;
  readonly "actions.requested"?: SlackEventHandler<"actions.requested">;
  readonly "action.result"?: SlackEventHandler<"action.result">;
  readonly "message.completed"?: SlackEventHandler<"message.completed">;
  readonly "message.appended"?: SlackEventHandler<"message.appended">;
  readonly "reasoning.appended"?: SlackEventHandler<"reasoning.appended">;
  readonly "reasoning.completed"?: SlackEventHandler<"reasoning.completed">;
  readonly "input.requested"?: SlackEventHandler<"input.requested">;
  readonly "turn.failed"?: SlackEventHandler<"turn.failed">;
  readonly "turn.completed"?: SlackEventHandler<"turn.completed">;
  readonly "turn.cancelled"?: SlackEventHandler<"turn.cancelled">;
  readonly "session.failed"?: SlackSessionFailedHandler;
  readonly "session.completed"?: SlackEventHandler<"session.completed">;
  readonly "session.waiting"?: SlackEventHandler<"session.waiting">;
  /**
   * Override receives {@link SlackAuthorizationEventContext}, a
   * private-delivery context (ephemeral or DM), not the full
   * {@link SlackEventContext}. The challenge is a credential, so a
   * public post is not expressible here.
   */
  readonly "authorization.required"?: SlackAuthorizationRequiredHandler;
  readonly "authorization.completed"?: SlackEventHandler<"authorization.completed">;
}

/**
 * Full-context variant of {@link SlackChannelEvents} consumed by the
 * channel internals. The framework's default `authorization.required`
 * handler keeps the full {@link SlackEventContext} because it owns the
 * public link-free status while user overrides remain private-only. The
 * factory adapts user overrides into this shape with
 * {@link constrainAuthorizationRequired}.
 */
export interface SlackChannelInternalEvents extends Omit<
  SlackChannelEvents,
  "authorization.required"
> {
  readonly "authorization.required"?: SlackEventHandler<"authorization.required">;
}

export interface SlackChannelConfig {
  readonly credentials?: SlackChannelCredentials;
  readonly botName?: string;

  /** Override the default webhook route path (`/eve/v1/slack`). */
  readonly route?: string;

  /**
   * Inbound upload policy applied to file attachments before they reach
   * the harness. Violating attachments are dropped with a warning so the
   * mention's text portion still gets delivered. Pass `"disabled"` to
   * reject every attachment. Defaults to the framework's 25 MB cap with
   * unrestricted media types.
   */
  readonly uploadPolicy?: UploadPolicyInput;

  /**
   * Adds earlier replies from the current Slack thread to each triggering
   * turn. Messages are rendered with their Slack sender ids attached so a
   * multi-user transcript retains unambiguous speaker attribution. Omit this
   * option to avoid fetching thread history.
   */
  readonly threadContext?: LoadThreadContextMessagesOptions;

  /**
   * Invoked when a Slack `app_mention` event arrives (only `app_mention`;
   * other event types are ignored). Decides whether to dispatch and with
   * what auth, and may run pre-dispatch side effects (e.g.
   * `ctx.thread.startTyping("Thinking...")`) on the inbound webhook side
   * before the runtime cold-starts.
   *
   * Return `{ auth }` to dispatch with that session auth context, or `null`
   * to drop the mention. May be sync or async; the result is awaited before
   * dispatching. Thrown errors are caught and logged and the mention is
   * dropped; wrap best-effort side effects in `try/catch` to keep them
   * non-fatal. Defaults to a workspace-scoped auth derivation that posts a
   * `"Thinking..."` typing indicator; replacing this replaces both.
   */
  onAppMention?(ctx: SlackContext, message: SlackMessage): SlackMentionResultOrPromise;

  /**
   * Invoked on a direct message: a Slack `message` event with
   * `channel_type: "im"`. Subtype messages (edits, deletes, joins, etc.)
   * and bot messages (`bot_id` set, including the bot's own replies) are
   * filtered out first, so handlers only see plain user-authored DMs.
   * Decides whether to dispatch and with what auth, and may run
   * pre-dispatch side effects on the inbound webhook side before cold-start.
   *
   * Return `{ auth }` to dispatch with that session auth context, or `null`
   * to drop the message. May be sync or async; the result is awaited before
   * dispatching. Thrown errors are caught and logged and the message is
   * dropped; wrap best-effort side effects in `try/catch` to keep them
   * non-fatal. Defaults to a workspace-scoped auth derivation that posts a
   * `"Thinking..."` typing indicator; replacing this replaces both.
   * Requires the bot's Slack app to subscribe to `message.im` with the
   * `im:history` scope.
   */
  onDirectMessage?(ctx: SlackContext, message: SlackMessage): SlackInboundResultOrPromise;

  /**
   * Handler for Slack `block_actions` interactive callbacks (button
   * clicks, select changes, etc.) **not** consumed by the framework's
   * HITL pipeline. Slack POSTs interactive payloads to the same webhook
   * route as mentions; the framework decodes them, routes any action whose
   * `action_id` starts with `eve_input:` to the runtime as an HITL
   * response (resuming a paused session), and forwards everything else
   * here, one invocation per non-HITL action.
   *
   * Runs on the inbound webhook side via `waitUntil()`, so the channel
   * returns `200 OK` immediately. Errors are caught and logged; they do
   * not affect the webhook response or sibling invocations.
   *
   * The `SlackContext` here is rebuilt from the interaction payload
   * (channel id, thread ts, team id), **not** the persisted thread state
   * used by event handlers. Use `ctx.slack.request(...)` for arbitrary
   * Slack Web API calls and `action.messageTs` to target `chat.update`.
   */
  onInteraction?(action: SlackInteractionAction, ctx: SlackContext): void | Promise<void>;

  readonly events?: SlackChannelEvents;
}

function rebuildSlackContext(
  state: SlackChannelState,
  session: SessionHandle,
  credentials: SlackChannelCredentials | undefined,
): SlackChannelContext {
  const { thread, slack } = buildSlackBinding({
    botToken: credentials?.botToken,
    channelId: state.channelId ?? "",
    threadTs: state.threadTs ?? "",
    teamId: state.teamId ?? undefined,
    onThreadTsChanged(ts) {
      state.threadTs = ts;
      if (state.channelId) {
        session.setContinuationToken(slackContinuationToken(state.channelId, ts));
      }
    },
  });
  return { thread, slack, state };
}

/**
 * Concrete return type of {@link slackChannel}. Named so consumers can
 * default-export a `slackChannel(...)` call under `declaration: true`
 * without TypeScript emitting an internal path for `Channel`.
 */
export interface SlackChannel extends Channel<
  SlackChannelState,
  SlackReceiveTarget,
  SlackInstrumentationMetadata
> {}

/**
 * Slack channel factory. Wires up the webhook route, mention dispatch,
 * interaction handling, and a baseline set of typing / error /
 * connection-auth event handlers. Defaults apply per field: pass
 * `onAppMention` to fully replace the default mention pipeline (auth
 * derivation plus `"Thinking..."` typing), or an `events[type]` handler to
 * replace only that one event. Unsupplied fields keep their defaults.
 */
export function slackChannel(config: SlackChannelConfig = {}): SlackChannel {
  const uploadPolicy = mergeUploadPolicy(config.uploadPolicy);
  const slackFetchFile = createSlackFetchFile({ botToken: config.credentials?.botToken });
  const onAppMention = config.onAppMention ?? defaultOnAppMention;
  const onDirectMessage = config.onDirectMessage ?? defaultOnDirectMessage;
  const authorizationRequiredOverride = config.events?.["authorization.required"];
  const turnStartedHandler = config.events?.["turn.started"] ?? defaultEvents["turn.started"]!;
  const mergedEvents: SlackChannelInternalEvents = {
    ...defaultEvents,
    ...config.events,
    async "turn.started"(data, channel, ctx) {
      const triggeringUserId = slackUserIdFromAuthContext(ctx.session.auth.current);
      if (triggeringUserId !== undefined) {
        channel.state.triggeringUserId = triggeringUserId;
      }
      await turnStartedHandler(data, channel, ctx);
    },
    "input.requested": config.events?.["input.requested"] ?? defaultInputRequestedHandler(),
    "authorization.required":
      authorizationRequiredOverride === undefined
        ? defaultEvents["authorization.required"]
        : constrainAuthorizationRequired(authorizationRequiredOverride),
  };

  // Set of events we've already handled on this process.
  // Light weight dedup mechanism - not reliable across multiple invocations.
  const handledEvents = new Set<string>();

  return defineChannel<
    SlackChannelState,
    SlackChannelContext,
    SlackReceiveTarget,
    SlackInstrumentationMetadata
  >({
    kindHint: "slack",
    state: {
      channelId: null as string | null,
      threadTs: null as string | null,
      teamId: null as string | null,
      triggeringUserId: null,
      pendingToolCallMessage: null,
      lastReasoningTypingAtMs: null,
      lastReasoningTypingStatus: null,
      pendingAuthMessageTs: {},
    },
    fetchFile: slackFetchFile,
    metadata(state): SlackInstrumentationMetadata {
      return {
        channelId: state.channelId,
        teamId: state.teamId,
        threadTs: state.threadTs,
        triggeringUserId: state.triggeringUserId ?? null,
      };
    },

    context(state, session) {
      return rebuildSlackContext(state, session, config.credentials);
    },

    routes: [
      POST<SlackChannelState>(
        config.route ?? SLACK_CHANNEL_DEFAULT_ROUTE,
        async (req, { send, waitUntil }) => {
          const body = await verifyInbound(req, config.credentials);
          if (body === null) return new Response("unauthorized", { status: 401 });

          if (shouldDropSlackHttpTimeoutRetry(req.headers)) {
            return new Response("ok");
          }

          const contentType = req.headers.get("content-type") ?? "";
          if (contentType.includes("application/x-www-form-urlencoded")) {
            return handleInteractionPost(body, { send, waitUntil }, { config });
          }
          return handleEventPost({
            body,
            send,
            waitUntil,
            onAppMention,
            onDirectMessage,
            uploadPolicy,
            threadContext: config.threadContext,
            handledEvents,
            headers: req.headers,
            credentials: config.credentials,
          });
        },
      ),
    ],

    async receive(input, { send }) {
      const receiveTarget = input.target as Partial<SlackReceiveTarget>;
      const channelId = receiveTarget.channelId;
      if (!channelId || typeof channelId !== "string") {
        throw new Error("slackChannel().receive requires target.channelId.");
      }
      const requestedThreadTs =
        typeof receiveTarget.threadTs === "string" ? receiveTarget.threadTs : "";
      const initialMessage = receiveTarget.initialMessage;
      if (initialMessage && requestedThreadTs.length > 0) {
        throw new Error(
          "slackChannel().receive: `threadTs` and `initialMessage` are mutually exclusive.",
        );
      }

      let threadTs = requestedThreadTs;
      if (initialMessage) {
        const { thread } = buildSlackBinding({
          botToken: config.credentials?.botToken,
          channelId,
          threadTs: "",
          teamId: undefined,
        });
        const postInput: { card: CardElement; fallbackText?: string } = {
          card: initialMessage.card,
        };
        if (initialMessage.fallbackText !== undefined) {
          postInput.fallbackText = initialMessage.fallbackText;
        }
        const posted = await thread.post(postInput);
        threadTs = posted.id;
      }

      // Threadless proactive runs need distinct identities until their first
      // Slack post supplies the real thread timestamp and re-keys the session.
      const continuationThreadTs = threadTs || crypto.randomUUID();

      return send(input.message, {
        auth: input.auth,
        continuationToken: slackContinuationToken(channelId, continuationThreadTs),
        state: {
          channelId,
          threadTs: threadTs || null,
          teamId: null,
          triggeringUserId: null,
        },
      });
    },

    events: mergedEvents,
  });
}

/**
 * Adapts a user-supplied `authorization.required` override to the full
 * internal event signature while handing it only the private-delivery
 * surface ({@link SlackAuthorizationEventContext}). Override code never
 * receives `thread.post` or the raw `slack.request` escape hatch, so the
 * challenge it renders cannot be addressed to the shared thread.
 */
export function constrainAuthorizationRequired(
  handler: SlackAuthorizationRequiredHandler,
): NonNullable<SlackChannelInternalEvents["authorization.required"]> {
  return (data, channel, ctx) =>
    handler(
      data,
      {
        postEphemeral: (userId, message) => channel.thread.postEphemeral(userId, message),
        postDirectMessage: (userId, message) => channel.thread.postDirectMessage(userId, message),
        state: channel.state,
      },
      ctx,
    );
}

function shouldDropSlackHttpTimeoutRetry(headers: Headers): boolean {
  const retryNum = Number(headers.get("x-slack-retry-num") ?? "0");
  return retryNum >= 1 && headers.get("x-slack-retry-reason") === "http_timeout";
}

/**
 * Handles an inbound non-interactivity Slack POST: parses the JSON
 * envelope, answers the URL-verification challenge, routes
 * `app_mention` events through `onAppMention` and `message`
 * events with `channel_type: "im"` through `onDirectMessage`, and
 * dispatches matching events via {@link dispatchInboundMessage} under
 * `waitUntil`. Returns the route's `200 OK` Response in every case
 * (Slack only cares that the webhook ACKs immediately).
 */
async function handleEventPost(input: {
  readonly body: string;
  readonly headers: Headers;
  readonly send: SendFn<SlackChannelState>;
  readonly waitUntil: (task: Promise<unknown>) => void;
  readonly onAppMention: NonNullable<SlackChannelConfig["onAppMention"]>;
  readonly onDirectMessage: NonNullable<SlackChannelConfig["onDirectMessage"]>;
  readonly uploadPolicy: UploadPolicy;
  readonly threadContext: LoadThreadContextMessagesOptions | undefined;
  readonly credentials: SlackChannelCredentials | undefined;
  readonly handledEvents: Set<string>;
}): Promise<Response> {
  let payload;
  try {
    payload = parseSlackWebhookBody(input.body, { headers: input.headers });
  } catch (error) {
    log.warn("inbound webhook body is not valid JSON", { error });
    return new Response("ok");
  }

  if (payload.kind === "url_verification") {
    return new Response(payload.challenge, {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  }

  if (payload.kind === "unsupported") return new Response("ok");

  if (payload.kind !== "app_mention" && payload.kind !== "direct_message") {
    return new Response("ok");
  }

  if (payload.eventId) {
    if (input.handledEvents.has(payload.eventId)) {
      log.warn("received a duplicate event", {
        event_id: payload.eventId,
        event_time: payload.eventTime,
        retry_num: payload.retry?.num ?? "(null)",
        retry_reason: payload.retry?.reason ?? "(null)",
      });
      return new Response("ok");
    }
    markEventHandled(payload.eventId, input.handledEvents);
  }

  const message = slackMessageFromWebhookPayload(payload);
  if (!message) return new Response("ok");

  if (payload.kind === "app_mention") {
    input.waitUntil(
      dispatchInboundMessage({
        kind: "app_mention",
        message,
        handler: input.onAppMention,
        send: input.send,
        uploadPolicy: input.uploadPolicy,
        threadContext: input.threadContext,
        credentials: input.credentials,
      }),
    );
    return new Response("ok");
  }

  if (payload.kind === "direct_message") {
    input.waitUntil(
      dispatchInboundMessage({
        kind: "direct_message",
        message,
        handler: input.onDirectMessage,
        send: input.send,
        uploadPolicy: input.uploadPolicy,
        threadContext: input.threadContext,
        credentials: input.credentials,
      }),
    );
    return new Response("ok");
  }

  return new Response("ok");
}

/**
 * Verifies the inbound Slack request and returns its raw body, or
 * `null` when verification fails. Failures are logged so misconfigured
 * deployments are visible — the route returns 401 to Slack.
 */
async function verifyInbound(
  req: Request,
  credentials: SlackChannelCredentials | undefined,
): Promise<string | null> {
  try {
    return await verifySlackRequest(req, {
      signingSecret:
        credentials?.signingSecret ??
        (credentials?.webhookVerifier ? undefined : process.env.SLACK_SIGNING_SECRET),
      webhookVerifier: credentials?.webhookVerifier,
    });
  } catch (error) {
    log.warn("slack inbound verification failed", { error });
    return null;
  }
}

/**
 * Runs the inbound handler for an `app_mention` or direct message and,
 * when it returns a non-null result, dispatches the message to the
 * runtime via `send`. Errors are caught and logged so a misbehaving
 * handler never crashes the webhook ACK.
 */
async function dispatchInboundMessage(input: {
  readonly kind: "app_mention" | "direct_message";
  readonly message: SlackMessage;
  readonly handler:
    | NonNullable<SlackChannelConfig["onAppMention"]>
    | NonNullable<SlackChannelConfig["onDirectMessage"]>;
  readonly send: SendFn<SlackChannelState>;
  readonly uploadPolicy: UploadPolicy;
  readonly threadContext: LoadThreadContextMessagesOptions | undefined;
  readonly credentials: SlackChannelCredentials | undefined;
}): Promise<void> {
  const { message, kind } = input;
  const { thread, slack } = buildSlackBinding({
    botToken: input.credentials?.botToken,
    channelId: message.channelId,
    threadTs: message.threadTs,
    teamId: message.teamId,
  });
  const slackCtx: SlackContext = { thread, slack };

  let result;
  try {
    result = await input.handler(slackCtx, message);
  } catch (error) {
    logError(log, `${kind} handler failed`, error, { channelId: message.channelId });
    return;
  }
  if (result === null || result === undefined) return;

  // This runs in the webhook's `waitUntil` task; an unguarded throw would
  // reject silently into the dispatch `allSettled` ("no response, no logs").
  try {
    const priorMessages =
      input.threadContext === undefined
        ? []
        : await loadThreadContextMessages(thread, message, input.threadContext);
    const threadContext = formatSlackThreadContext(priorMessages);
    const fileParts = await collectInboundFileParts({
      mention: message,
      thread,
      policy: input.uploadPolicy,
    });
    const inboundContext: SlackInboundContext = {
      channelId: message.channelId,
      fullName: message.author?.fullName,
      teamId: message.teamId,
      threadTs: message.threadTs,
      userId: message.author?.userId ?? "",
      userName: message.author?.userName,
    };
    const attributedMessage = formatSlackInboundMessage(inboundContext, message);
    const turnMessage = buildSlackTurnMessage(
      threadContext === undefined ? attributedMessage : `${threadContext}\n\n${attributedMessage}`,
      fileParts,
    );

    const channelContext = result.context ?? [];

    await input.send(
      channelContext.length === 0
        ? { message: turnMessage }
        : { message: turnMessage, context: channelContext },
      {
        auth: result.auth,
        continuationToken: slackContinuationToken(message.channelId, message.threadTs),
        state: {
          channelId: message.channelId,
          threadTs: message.threadTs,
          teamId: message.teamId ?? null,
          triggeringUserId: inboundContext.userId || null,
        },
        title: message.markdown,
      },
    );
  } catch (error) {
    logError(log, `${kind} delivery failed`, error, { channelId: message.channelId });
  }
}
