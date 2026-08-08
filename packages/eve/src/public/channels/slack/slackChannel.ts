import { parseSlackWebhookBody } from "#compiled/@chat-adapter/slack/webhook.js";

import type { UserContent } from "ai";
import type {
  ChannelFrom,
  ChannelResolveSession,
  ChannelSource,
} from "#channel/channel-operations.js";
import type { Session, SessionHandle } from "#channel/session.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { CardElement } from "#compiled/chat/index.js";
import type { SessionContext } from "#public/definitions/callback-context.js";
import type { ChannelContinuationOps } from "#public/definitions/channel.js";

import { createLogger, logError } from "#internal/logging.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import {
  buildSlackBinding,
  buildSlackWorkspaceHandle,
  slackContinuationToken,
  type SlackBotToken,
  type SlackHandle,
  type SlackThread,
  type SlackWorkspaceHandle,
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
  parseMessageEvent,
  type SlackEvent,
  slackEventBotUserId,
  type SlackEventEnvelope,
  type SlackInboundContext,
  type SlackMessage,
  parseSlackEventEnvelope,
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
import { buildSlackAuthContext, slackUserIdFromAuthContext } from "#public/channels/slack/auth.js";
import { SLACK_CHANNEL_DEFAULT_ROUTE } from "#public/channels/slack/constants.js";
import { handleInteractionPost } from "#public/channels/slack/interactions.js";
import {
  bindSlackSessionOperations,
  type SlackSendOptions,
  type SlackSessionOperations,
} from "#public/channels/slack/session-operations.js";
import {
  mergeUploadPolicy,
  type UploadPolicy,
  type UploadPolicyInput,
} from "#public/channels/upload-policy.js";
import { verifySlackRequest, type SlackWebhookVerifier } from "#public/channels/slack/verify.js";
import { defineChannel, POST, type Channel } from "#public/definitions/channel.js";

export type {
  SlackRespondOptions,
  SlackSendOptions,
  SlackSessionOperations,
} from "#public/channels/slack/session-operations.js";

const log = createLogger("slack.channel");

type EventData<T extends UnstampedMessageStreamEvent["type"]> =
  Extract<UnstampedMessageStreamEvent, { type: T }> extends { data: infer D } ? D : undefined;

/**
 * Base Slack context for inbound webhook handlers. These hooks run before the
 * runtime hydrates session state, so `state` is absent here.
 * {@link thread} owns thread-scoped operations (`post`, `postEphemeral`,
 * `startTyping`, `refresh`, `listParticipants`, `recentMessages`,
 * `mentionUser`); {@link slack} owns Slack identity (`channelId`, `threadTs`,
 * `teamId`) plus the raw-API escape hatch (`request`, `uploadFiles`).
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
 * continuation routing ({@link ChannelContinuationOps}). Unlike the pre-dispatch
 * {@link SlackContext}, `state` is hydrated here.
 */
export interface SlackEventContext extends SlackChannelContext, ChannelContinuationOps {}

export type {
  SlackApiResponse,
  SlackBotToken,
  SlackHandle,
  SlackThread,
  SlackWorkspaceHandle,
} from "#public/channels/slack/api.js";
export type { SlackWebhookVerifier } from "#public/channels/slack/verify.js";

type SlackEventHandler<T extends UnstampedMessageStreamEvent["type"]> = (
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

/** Target accepted by `ctx.to(slack, target)` from route and schedule handlers. */
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

/**
 * Options for one turn requested by a generic Slack event handler.
 */
export interface SlackEventSendOptions {
  readonly auth: SessionAuthContext | null;
  readonly target: SlackReceiveTarget;
}

/** Options for answering pending input requests from a generic Slack event handler. */
export interface SlackEventRespondOptions {
  readonly auth: SessionAuthContext | null;
  readonly target: SlackSessionTarget;
}

/**
 * Starts a session on the current Slack channel from `onEvent`. Call it zero,
 * one, or many times; each invocation returns the resulting session.
 */
export type SlackEventSendFn = (
  message: string | UserContent,
  options: SlackEventSendOptions,
) => Promise<Session>;

/** Answers pending input requests on one Slack thread. */
export type SlackEventRespondFn = (
  inputResponses: Parameters<SlackSessionOperations["respond"]>[0],
  options: SlackEventRespondOptions,
) => ReturnType<SlackSessionOperations["respond"]>;

/**
 * Slack thread identity used by workspace-scoped inbound helpers.
 */
export interface SlackSessionTarget {
  readonly channelId: string;
  readonly threadTs: string;
}

/**
 * Imperative surface handed to `slackChannel({ onEvent })`. Generic Events API
 * payloads are not necessarily tied to one thread, so the context exposes a
 * workspace API handle plus Slack-bound operations rather than the
 * thread-scoped {@link SlackContext} used by message handlers.
 */
export interface SlackInboundEventContext {
  /** Starts a turn on this Slack channel using the proactive send contract. */
  readonly send: SlackEventSendFn;
  /** Answers pending input requests on one Slack thread. */
  readonly respond: SlackEventRespondFn;
  /** Cancels the active turn for one Slack thread. */
  cancel(input: {
    readonly target: SlackSessionTarget;
    readonly turnId?: string;
  }): ReturnType<ChannelSource<SlackChannelState>["cancel"]>;
  /** Compacts the current session for one Slack thread. */
  compact(input: {
    readonly target: SlackSessionTarget;
  }): ReturnType<ChannelSource<SlackChannelState>["compact"]>;
  /** Clears the current session for one Slack thread. */
  clear(input: {
    readonly target: SlackSessionTarget;
  }): ReturnType<ChannelSource<SlackChannelState>["clear"]>;
  /** Resets the current session for one Slack thread. */
  reset(input: {
    readonly reason?: string;
    readonly target: SlackSessionTarget;
  }): ReturnType<ChannelSource<SlackChannelState>["reset"]>;
  /** Resolves the current session for one Slack thread. */
  resolveSession(input: { readonly target: SlackSessionTarget }): ReturnType<ChannelResolveSession>;
  /** The complete signed Events API callback envelope. */
  readonly envelope: SlackEventEnvelope;
  /** Workspace-scoped Slack identity and raw Web API escape hatch. */
  readonly slack: SlackWorkspaceHandle;
  /** Keeps detached handler work alive after the Slack webhook is acknowledged. */
  readonly waitUntil: (task: Promise<unknown>) => void;
}

/**
 * Message-scoped context handed to `onMessage`, `onAppMention`, and
 * `onDirectMessage`.
 */
export interface SlackInboundMessageContext extends SlackContext, SlackSessionOperations {
  /** Returns whether this message belongs to a thread with an active eve session. */
  isSubscribed(): Promise<boolean>;
  /** Returns whether the inbound event explicitly mentions this bot. */
  isBotMentioned(): boolean;
}

/** Interaction-scoped context handed to `slackChannel({ onInteraction })`. */
export interface SlackInteractionContext extends SlackContext, SlackSessionOperations {}

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
 * {@link SessionContext}; `session.failed` receives only data and channel
 * context and exposes the ID as `data.sessionId`.
 */
export interface SlackChannelEvents {
  readonly "turn.started"?: SlackEventHandler<"turn.started">;
  readonly "actions.requested"?: SlackEventHandler<"actions.requested">;
  readonly "action.partial"?: SlackEventHandler<"action.partial">;
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
   * Handles human-authored Slack messages. Specialized `onAppMention` and
   * `onDirectMessage` handlers take precedence for their event types. Other
   * channel messages are ignored when this hook is omitted.
   */
  onMessage?(ctx: SlackInboundMessageContext, message: SlackMessage): SlackInboundResultOrPromise;

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
  onAppMention?(
    ctx: SlackInboundMessageContext,
    message: SlackMessage,
  ): SlackMentionResultOrPromise;

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
  onDirectMessage?(
    ctx: SlackInboundMessageContext,
    message: SlackMessage,
  ): SlackInboundResultOrPromise;

  /**
   * Fallback handler for signed Slack Events API callbacks. An authored
   * `onAppMention` or `onDirectMessage` takes precedence for events accepted
   * by that specialized handler; otherwise the raw event arrives here. When
   * neither a specialized handler nor `onEvent` is authored, mentions and DMs
   * retain their built-in defaults and other event types are ignored.
   *
   * The handler owns control flow. Call `ctx.send(...)` zero, one, or many
   * times to start turns on Slack, and use `ctx.waitUntil(...)` for detached
   * work. The return value is ignored. Runs after the webhook has been
   * acknowledged through the host's `waitUntil` mechanism. Errors are caught
   * and logged and never fall through to another handler.
   *
   * URL verification, slash commands, and interactive payloads are not Events
   * API callbacks and do not reach this handler.
   */
  onEvent?(ctx: SlackInboundEventContext, event: SlackEvent): void | Promise<void>;

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
  onInteraction?(
    action: SlackInteractionAction,
    ctx: SlackInteractionContext,
  ): void | Promise<void>;

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
        session.continuation?.rekey(slackContinuationToken(state.channelId, ts));
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
 * replace only that one event. When `onEvent` is authored it becomes the
 * fallback ahead of unsupplied mention and DM defaults; otherwise unsupplied
 * fields keep their defaults.
 */
export function slackChannel(config: SlackChannelConfig = {}): SlackChannel {
  const uploadPolicy = mergeUploadPolicy(config.uploadPolicy);
  const slackFetchFile = createSlackFetchFile({ botToken: config.credentials?.botToken });
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
      POST<SlackChannelState>(config.route ?? SLACK_CHANNEL_DEFAULT_ROUTE, async (req, args) => {
        const { waitUntil } = args;
        const { from, resolveSession } = args;
        const body = await verifyInbound(req, config.credentials);
        if (body === null) return new Response("unauthorized", { status: 401 });

        const contentType = req.headers.get("content-type") ?? "";
        if (contentType.includes("application/x-www-form-urlencoded")) {
          return handleInteractionPost(body, { from, resolveSession, waitUntil }, { config });
        }
        return handleEventPost({
          body,
          from,
          resolveSession,
          waitUntil,
          config,
          uploadPolicy,
          headers: req.headers,
        });
      }),
    ],

    receive(input, { from }) {
      return receiveOnSlack(input, { from, credentials: config.credentials });
    },

    events: mergedEvents,
  });
}

/**
 * Shared proactive Slack receive path used by both the channel's public
 * `receive` hook and the pre-bound `send` function exposed to `onEvent`.
 */
async function receiveOnSlack(
  input: {
    readonly auth: SessionAuthContext | null;
    readonly message: string | UserContent;
    readonly target: SlackReceiveTarget;
  },
  deps: {
    readonly from: ChannelFrom<SlackChannelState>;
    readonly credentials: SlackChannelCredentials | undefined;
    /** Provider delivery id for an inbound event-triggered send. */
    readonly idempotencyKey?: string;
    /** Slack team id seeded into session state, when the trigger carried one. */
    readonly teamId?: string;
    /** Slack user id seeded into session state, when the trigger carried one. */
    readonly triggeringUserId?: string;
  },
): Promise<Session> {
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
      botToken: deps.credentials?.botToken,
      channelId,
      threadTs: "",
      teamId: deps.teamId,
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

  return deps.from(slackContinuationToken(channelId, continuationThreadTs)).send(input.message, {
    auth: input.auth,
    idempotencyKey: deps.idempotencyKey,
    state: {
      channelId,
      threadTs: threadTs || null,
      teamId: deps.teamId ?? null,
      triggeringUserId: deps.triggeringUserId ?? null,
    },
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

/**
 * Handles an inbound non-interactivity Slack POST: parses the JSON envelope,
 * answers URL verification, selects one authored specific handler, generic
 * fallback, or built-in message default, and schedules it under `waitUntil`.
 * Returns `200 OK` in every case because Slack only requires an immediate ACK.
 */
async function handleEventPost(input: {
  readonly body: string;
  readonly from: ChannelFrom<SlackChannelState>;
  readonly resolveSession: ChannelResolveSession;
  readonly headers: Headers;
  readonly waitUntil: (task: Promise<unknown>) => void;
  readonly config: SlackChannelConfig;
  readonly uploadPolicy: UploadPolicy;
}): Promise<Response> {
  const { config } = input;
  let payload;
  let envelope: SlackEventEnvelope | null;
  try {
    payload = parseSlackWebhookBody(input.body, { headers: input.headers });
    envelope = parseSlackEventEnvelope(input.body);
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

  if (envelope === null) return new Response("ok");
  const appId = typeof envelope.api_app_id === "string" ? envelope.api_app_id : undefined;
  const botUserId = slackEventBotUserId(envelope);
  const idempotencyKey = envelope.event_id;

  // Handler precedence, in fall-through order:
  // 1) an authored mention/DM handler for its own event kind,
  // 2) an authored generic `onEvent` fallback,
  // 3) the built-in mention/DM defaults.
  let dispatch: (() => Promise<void>) | null = null;
  let builtinDefault: (() => Promise<void>) | null = null;

  if (payload.kind === "app_mention" || payload.kind === "direct_message") {
    const kind = payload.kind;
    const message = slackMessageFromWebhookPayload(payload);
    if (message !== null && !isSelfAuthoredSlackMessage({ appId, botUserId }, message)) {
      const dispatchMessageWith =
        (handler: NonNullable<SlackChannelConfig["onAppMention"]>) => () =>
          dispatchSlackMessage({
            appId,
            botUserId,
            from: input.from,
            resolveSession: input.resolveSession,
            credentials: config.credentials,
            handler,
            idempotencyKey,
            kind,
            message,
            threadContext: config.threadContext,
            uploadPolicy: input.uploadPolicy,
          });
      const specialized = kind === "app_mention" ? config.onAppMention : config.onDirectMessage;
      const handler = specialized ?? config.onMessage;
      if (handler !== undefined) {
        dispatch = () =>
          dispatchSlackMessage({
            appId,
            botUserId,
            from: input.from,
            resolveSession: input.resolveSession,
            credentials: config.credentials,
            handler,
            idempotencyKey,
            kind,
            message,
            threadContext: config.threadContext,
            uploadPolicy: input.uploadPolicy,
          });
      } else {
        builtinDefault = dispatchMessageWith(
          kind === "app_mention" ? defaultOnAppMention : defaultOnDirectMessage,
        );
      }
    }
  }

  if (dispatch === null && config.onMessage !== undefined) {
    const message = parseMessageEvent(envelope);
    if (message !== null && !isSelfAuthoredSlackMessage({ appId, botUserId }, message)) {
      // Slack also emits message.channels for an app mention. The app_mention
      // callback owns that user action so the generic message is not duplicated.
      if (botUserId === undefined || !message.text.includes(`<@${botUserId}`)) {
        dispatch = () =>
          dispatchSlackMessage({
            appId,
            botUserId,
            from: input.from,
            resolveSession: input.resolveSession,
            credentials: config.credentials,
            handler: config.onMessage!,
            idempotencyKey,
            kind: "channel_message",
            message,
            threadContext: config.threadContext,
            uploadPolicy: input.uploadPolicy,
          });
      }
    }
  }

  // Specialized handlers retain their bot/subtype filters. onMessage receives
  // structurally valid messages except this app's own; onEvent is the raw fallback.
  const onEvent = config.onEvent;
  if (dispatch === null && onEvent !== undefined) {
    dispatch = () =>
      dispatchSlackEvent({
        from: input.from,
        resolveSession: input.resolveSession,
        credentials: config.credentials,
        envelope,
        handler: onEvent,
        idempotencyKey,
      });
  }

  dispatch ??= builtinDefault;
  if (dispatch === null) return new Response("ok");

  input.waitUntil(dispatch());
  return new Response("ok");
}

function isSelfAuthoredSlackMessage(
  identity: { readonly appId: string | undefined; readonly botUserId: string | undefined },
  message: SlackMessage,
): boolean {
  if (identity.botUserId !== undefined && message.author?.userId === identity.botUserId) {
    return true;
  }

  // App-authored message events can omit `user`, so match Slack's app identity
  // as a fallback. Other bots keep flowing to authored onMessage handlers.
  return identity.appId !== undefined && message.raw.app_id === identity.appId;
}

async function dispatchSlackMessage(input: {
  readonly appId: string | undefined;
  readonly botUserId: string | undefined;
  readonly from: ChannelFrom<SlackChannelState>;
  readonly resolveSession: ChannelResolveSession;
  readonly credentials: SlackChannelCredentials | undefined;
  readonly handler: NonNullable<SlackChannelConfig["onMessage"]>;
  readonly idempotencyKey: string | undefined;
  readonly kind: "app_mention" | "channel_message" | "direct_message";
  readonly message: SlackMessage;
  readonly threadContext: LoadThreadContextMessagesOptions | undefined;
  readonly uploadPolicy: UploadPolicy;
}): Promise<void> {
  const continuationToken = slackContinuationToken(input.message.channelId, input.message.threadTs);
  const { thread, slack } = buildSlackBinding({
    appId: input.appId,
    botToken: input.credentials?.botToken,
    botUserId: input.botUserId,
    channelId: input.message.channelId,
    threadTs: input.message.threadTs,
    teamId: input.message.teamId,
  });
  const author = input.message.author;
  const sessionOperations = bindSlackSessionOperations({
    address: continuationToken,
    defaultAuth:
      author === undefined
        ? null
        : buildSlackAuthContext({
            channelId: input.message.channelId,
            fullName: author.fullName,
            isBot: author.isBot,
            teamId: input.message.teamId,
            threadTs: input.message.threadTs,
            userId: author.userId,
            userName: author.userName,
          }),
    from: input.from,
    resolveSession: input.resolveSession,
    state: {
      channelId: input.message.channelId,
      teamId: input.message.teamId ?? null,
      threadTs: input.message.threadTs,
      triggeringUserId: author?.userId ?? null,
    },
  });
  const ctx: SlackInboundMessageContext = {
    ...sessionOperations,
    isBotMentioned: () =>
      input.kind === "app_mention" ||
      (input.botUserId !== undefined && input.message.text.includes(`<@${input.botUserId}`)),
    isSubscribed: async () => (await sessionOperations.resolveSession()) !== undefined,
    slack,
    thread,
  };

  let result;
  try {
    result = await input.handler(ctx, input.message);
  } catch (error) {
    logError(log, `${input.kind} handler failed`, error, {
      channelId: input.message.channelId,
    });
    return;
  }
  if (result === null || result === undefined) return;

  await deliverSlackMessage({
    credentials: input.credentials,
    kind: input.kind,
    idempotencyKey: input.idempotencyKey,
    message: input.message,
    result,
    sessionOperations,
    thread,
    threadContext: input.threadContext,
    uploadPolicy: input.uploadPolicy,
  });
}

/** Runs a generic Events API handler with an imperative Slack operation surface. */
async function dispatchSlackEvent(input: {
  readonly from: ChannelFrom<SlackChannelState>;
  readonly resolveSession: ChannelResolveSession;
  readonly credentials: SlackChannelCredentials | undefined;
  readonly envelope: SlackEventEnvelope;
  readonly handler: NonNullable<SlackChannelConfig["onEvent"]>;
  readonly idempotencyKey: string | undefined;
}): Promise<void> {
  const eventTeamId = input.envelope.event.team_id;
  const teamId =
    typeof eventTeamId === "string"
      ? eventTeamId
      : typeof input.envelope.team_id === "string"
        ? input.envelope.team_id
        : undefined;
  const waitUntilTasks: Promise<unknown>[] = [];
  const sourceFor = (target: SlackSessionTarget) =>
    input.from(slackContinuationToken(target.channelId, target.threadTs));
  const ctx: SlackInboundEventContext = {
    cancel: ({ target, turnId }) => sourceFor(target).cancel({ turnId }),
    clear: ({ target }) => sourceFor(target).clear(),
    compact: ({ target }) => sourceFor(target).compact(),
    envelope: input.envelope,
    reset: ({ reason, target }) => sourceFor(target).reset({ reason }),
    resolveSession: ({ target }) =>
      input.resolveSession(slackContinuationToken(target.channelId, target.threadTs)),
    respond: (inputResponses, { auth, target }) =>
      sourceFor(target).respond(inputResponses, { auth }),
    send: (message, { auth, target }) =>
      receiveOnSlack(
        { auth, message, target },
        {
          from: input.from,
          credentials: input.credentials,
          idempotencyKey: input.idempotencyKey,
          teamId,
          ...(typeof input.envelope.event.user === "string"
            ? { triggeringUserId: input.envelope.event.user }
            : {}),
        },
      ),
    slack: buildSlackWorkspaceHandle({
      botToken: input.credentials?.botToken,
      teamId,
    }),
    waitUntil(task) {
      waitUntilTasks.push(task);
    },
  };

  try {
    await input.handler(ctx, input.envelope.event);
  } catch (error) {
    logError(log, "event handler failed", error, {
      eventId: input.envelope.event_id,
      eventType: input.envelope.event.type,
    });
  }

  await Promise.allSettled(waitUntilTasks);
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

async function deliverSlackMessage(input: {
  readonly sessionOperations: SlackSessionOperations;
  readonly credentials: SlackChannelCredentials | undefined;
  readonly kind: string;
  readonly idempotencyKey: string | undefined;
  readonly message: SlackMessage;
  readonly result: Exclude<SlackInboundResult, null>;
  readonly thread: SlackThread;
  readonly threadContext: LoadThreadContextMessagesOptions | undefined;
  readonly uploadPolicy: UploadPolicy;
}): Promise<void> {
  const { message, thread } = input;
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

    const channelContext = input.result.context ?? [];
    const sendOptions: SlackSendOptions =
      channelContext.length === 0
        ? {
            auth: input.result.auth,
            idempotencyKey: input.idempotencyKey,
            title: message.markdown,
          }
        : {
            auth: input.result.auth,
            context: channelContext,
            idempotencyKey: input.idempotencyKey,
            title: message.markdown,
          };

    await input.sessionOperations.send(turnMessage, sendOptions);
  } catch (error) {
    logError(log, `${input.kind} delivery failed`, error, { channelId: message.channelId });
  }
}
