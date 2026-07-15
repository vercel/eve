import type { SessionHandle } from "#channel/session.js";
import type { SessionAuthContext } from "#channel/types.js";
import { createLogger } from "#internal/logging.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import {
  createLinearAgentActivity,
  createLinearAgentSessionOnComment,
  createLinearAgentSessionOnIssue,
  listLinearAgentSessionActivities,
  updateLinearAgentSession,
  type LinearAgentSessionRecord,
  type LinearApiOptions,
} from "#public/channels/linear/api.js";
import type { LinearChannelCredentials } from "#public/channels/linear/auth.js";
import { LINEAR_CHANNEL_DEFAULT_ROUTE } from "#public/channels/linear/constants.js";
import { createDefaultEvents, defaultOnAgentSession } from "#public/channels/linear/defaults.js";
import { resolveLinearPromptInputResponses } from "#public/channels/linear/hitl.js";
import {
  formatLinearContextBlock,
  linearContinuationToken,
  messageFromLinearAgentSessionEvent,
  parseLinearWebhookEvent,
  type LinearAgentSessionEvent,
  type LinearAgentSessionRef,
  type LinearDataWebhookEvent,
  type LinearDelivery,
} from "#public/channels/linear/inbound.js";
import { verifyLinearRequest } from "#public/channels/linear/verify.js";
import type { SessionContext } from "#public/definitions/callback-context.js";
import {
  defineChannel,
  POST,
  type Channel,
  type ChannelSessionOps,
  type SendFn,
} from "#public/definitions/channel.js";
import { isObject } from "#shared/guards.js";
import type { JsonObject } from "#shared/json.js";
import type { InputResponse } from "#runtime/input/types.js";

const log = createLogger("linear.channel");

type EventData<T extends HandleMessageStreamEvent["type"]> =
  Extract<HandleMessageStreamEvent, { type: T }> extends { data: infer D } ? D : undefined;

/** JSON-serializable state for one Linear Agent Session conversation. */
export interface LinearChannelState {
  readonly agentSessionId: string | null;
  readonly agentSessionUrl?: string | null;
  readonly commentId?: string | null;
  readonly issueId?: string | null;
  readonly issueIdentifier?: string | null;
  readonly issueTitle?: string | null;
  readonly issueUrl?: string | null;
  readonly organizationId?: string | null;
  /**
   * Buffered text from a `message.completed` event whose `finishReason`
   * was `"tool-calls"`. The default `actions.requested` handler uses this
   * as the next ephemeral progress activity, matching Slack's typing status.
   */
  pendingToolCallMessage?: string | null;
  readonly sourceCommentId?: string | null;
}

/** Per-session instrumentation snapshot for Linear runtime telemetry. */
export interface LinearInstrumentationMetadata extends Record<string, unknown> {
  readonly agentSessionId: string | null;
  readonly commentId: string | null;
  readonly issueId: string | null;
  readonly issueIdentifier: string | null;
  readonly organizationId: string | null;
}

/** Target accepted by `receive(linear, { target })` for proactive Linear sessions. */
export type LinearReceiveTarget =
  | {
      readonly agentSessionId: string;
      readonly initialActivity?: string;
    }
  | {
      readonly externalLink?: string;
      readonly externalUrls?: readonly { readonly label: string; readonly url: string }[];
      readonly initialActivity?: string;
      readonly issueId: string;
    }
  | {
      readonly commentId: string;
      readonly externalLink?: string;
      readonly externalUrls?: readonly { readonly label: string; readonly url: string }[];
      readonly initialActivity?: string;
    };

/** Pre-dispatch Linear context passed to inbound hooks. */
export interface LinearSessionContext {
  readonly delivery: LinearDelivery;
  readonly linear: LinearHandle;
  readonly session: LinearAgentSessionRef;
}

/** Channel-owned Linear context rebuilt from persisted channel state. */
export interface LinearChannelContext {
  readonly linear: LinearHandle;
  state: LinearChannelState;
}

/** Event-handler Linear context, including session operations. */
export interface LinearEventContext extends LinearChannelContext, ChannelSessionOps {}

/** Low-level Linear handle exposed to hooks and event handlers. */
export interface LinearHandle {
  readonly agentSessionId: string;
  createActivity(
    content: Parameters<typeof createLinearAgentActivity>[0]["activity"]["content"],
    options?: {
      readonly ephemeral?: boolean;
      readonly signal?: Parameters<typeof createLinearAgentActivity>[0]["activity"]["signal"];
      readonly signalMetadata?: JsonObject;
    },
  ): Promise<{ readonly id: string; readonly success: boolean }>;
  listActivities(options?: {
    readonly last?: number;
  }): Promise<Awaited<ReturnType<typeof listLinearAgentSessionActivities>>>;
  updateSession(
    update: Parameters<typeof updateLinearAgentSession>[0]["update"],
  ): Promise<{ readonly success: boolean }>;
}

type LinearEventHandler<T extends HandleMessageStreamEvent["type"]> = (
  data: EventData<T>,
  channel: LinearEventContext,
  ctx: SessionContext,
) => void | Promise<void>;

type LinearSessionFailedHandler = (
  data: EventData<"session.failed">,
  channel: LinearEventContext,
) => void | Promise<void>;

/** Event handlers supported by `linearChannel({ events })`. */
export interface LinearChannelEvents {
  readonly "turn.started"?: LinearEventHandler<"turn.started">;
  readonly "actions.requested"?: LinearEventHandler<"actions.requested">;
  readonly "action.result"?: LinearEventHandler<"action.result">;
  readonly "message.completed"?: LinearEventHandler<"message.completed">;
  readonly "message.appended"?: LinearEventHandler<"message.appended">;
  readonly "input.requested"?: LinearEventHandler<"input.requested">;
  readonly "turn.failed"?: LinearEventHandler<"turn.failed">;
  readonly "turn.completed"?: LinearEventHandler<"turn.completed">;
  readonly "turn.cancelled"?: LinearEventHandler<"turn.cancelled">;
  readonly "session.failed"?: LinearSessionFailedHandler;
  readonly "session.completed"?: LinearEventHandler<"session.completed">;
  readonly "session.waiting"?: LinearEventHandler<"session.waiting">;
  readonly "authorization.required"?: LinearEventHandler<"authorization.required">;
  readonly "authorization.completed"?: LinearEventHandler<"authorization.completed">;
}

/**
 * Result of an inbound Linear hook. Return `null` to acknowledge without
 * dispatching; return `{ auth }` to dispatch. Optional `context` strings are
 * added as `role: "user"` messages before the dispatched turn.
 */
export type LinearInboundResult = {
  readonly auth: SessionAuthContext | null;
  readonly context?: readonly string[];
} | null;

/** Sync or async {@link LinearInboundResult}. */
export type LinearInboundResultOrPromise = LinearInboundResult | Promise<LinearInboundResult>;

/** Configuration for {@link linearChannel}. */
export interface LinearChannelConfig {
  readonly api?: LinearApiOptions;
  readonly credentials?: LinearChannelCredentials;
  readonly events?: LinearChannelEvents;
  readonly route?: string;

  /** Inbound Agent Session hook. Defaults to dispatching `created` and `prompted` events. */
  onAgentSession?(
    ctx: LinearSessionContext,
    event: LinearAgentSessionEvent,
  ): LinearInboundResultOrPromise;

  /** Optional hook for generic Linear data webhooks sent to the same route. */
  onDataWebhook?(event: LinearDataWebhookEvent): void | Promise<void>;
}

/** Concrete return type of {@link linearChannel}. */
export interface LinearChannel extends Channel<
  LinearChannelState,
  LinearReceiveTarget,
  LinearInstrumentationMetadata
> {}

/** Linear channel factory for Linear Agent Session webhooks and Agent Activities. */
export function linearChannel(config: LinearChannelConfig = {}): LinearChannel {
  const onAgentSession = config.onAgentSession ?? defaultOnAgentSession;
  const mergedEvents: LinearChannelEvents = {
    ...createDefaultEvents({ api: config.api, credentials: config.credentials }),
    ...config.events,
  };

  return defineChannel<
    LinearChannelState,
    LinearChannelContext,
    LinearReceiveTarget,
    LinearInstrumentationMetadata
  >({
    kindHint: "linear",
    state: initialLinearState(),
    metadata(state): LinearInstrumentationMetadata {
      return {
        agentSessionId: state.agentSessionId,
        commentId: state.commentId ?? null,
        issueId: state.issueId ?? null,
        issueIdentifier: state.issueIdentifier ?? null,
        organizationId: state.organizationId ?? null,
      };
    },

    context(state, session) {
      return rebuildLinearContext(state, session, config);
    },

    routes: [
      POST<LinearChannelState>(
        config.route ?? LINEAR_CHANNEL_DEFAULT_ROUTE,
        async (req, { send, waitUntil }) => {
          const body = await verifyInbound(req, config.credentials);
          if (body === null) return new Response("unauthorized", { status: 401 });

          let event;
          try {
            event = parseLinearWebhookEvent({ body, headers: req.headers });
          } catch (error) {
            log.warn("inbound Linear body is not valid JSON", { error });
            return jsonOk({ ignored: true, ok: true });
          }

          if (event === null) return jsonOk({ ignored: true, ok: true });

          if (event.kind === "agent_session") {
            waitUntil(dispatchAgentSession({ config, event, onAgentSession, send }));
            return jsonOk({ ok: true });
          }

          if (config.onDataWebhook !== undefined) {
            waitUntil(Promise.resolve(config.onDataWebhook(event)));
            return jsonOk({ ok: true });
          }

          return jsonOk({ ignored: true, ok: true });
        },
      ),
    ],

    async receive(input, { send }) {
      const target = input.target as Record<string, unknown>;
      const session = await resolveReceiveSession(target, config);

      const initialActivity = readString(target.initialActivity);
      if (initialActivity !== undefined) {
        await createLinearAgentActivity({
          api: config.api,
          credentials: config.credentials,
          activity: {
            agentSessionId: session.id,
            content: { body: initialActivity, type: "thought" },
          },
        });
      }

      return send(input.message, {
        auth: input.auth,
        continuationToken: linearContinuationToken(session.id),
        state: stateFromAgentSession(session),
      });
    },

    events: mergedEvents,
  });
}

function rebuildLinearContext(
  state: LinearChannelState,
  _session: SessionHandle,
  config: LinearChannelConfig,
): LinearChannelContext {
  return {
    linear: buildLinearHandle({ agentSessionId: state.agentSessionId ?? "", config }),
    state,
  };
}

function buildLinearHandle(input: {
  readonly agentSessionId: string;
  readonly config: LinearChannelConfig;
}): LinearHandle {
  return {
    agentSessionId: input.agentSessionId,
    createActivity(content, options) {
      return createLinearAgentActivity({
        api: input.config.api,
        credentials: input.config.credentials,
        activity: {
          agentSessionId: input.agentSessionId,
          content,
          ephemeral: options?.ephemeral,
          signal: options?.signal,
          signalMetadata: options?.signalMetadata,
        },
      });
    },
    listActivities(options) {
      return listLinearAgentSessionActivities({
        api: input.config.api,
        credentials: input.config.credentials,
        agentSessionId: input.agentSessionId,
        last: options?.last,
      });
    },
    updateSession(update) {
      return updateLinearAgentSession({
        api: input.config.api,
        credentials: input.config.credentials,
        id: input.agentSessionId,
        update,
      });
    },
  };
}

async function dispatchAgentSession(input: {
  readonly config: LinearChannelConfig;
  readonly event: LinearAgentSessionEvent;
  readonly onAgentSession: NonNullable<LinearChannelConfig["onAgentSession"]>;
  readonly send: SendFn<LinearChannelState>;
}): Promise<void> {
  const { event } = input;
  const context: LinearSessionContext = {
    delivery: event.delivery,
    linear: buildLinearHandle({ agentSessionId: event.agentSession.id, config: input.config }),
    session: event.agentSession,
  };
  const result = await input.onAgentSession(context, event);
  if (result === null) return;

  const body = event.agentActivity?.body;
  const inputResponses =
    event.action === "prompted" && body !== undefined
      ? await resolvePromptResponses({ body, config: input.config, event })
      : [];

  await input.send(
    {
      context: [
        formatLinearContextBlock(event),
        ...event.previousComments,
        ...(result.context ?? []),
      ],
      inputResponses,
      message: messageFromLinearAgentSessionEvent(event),
    },
    {
      auth: result.auth,
      continuationToken: linearContinuationToken(event.agentSession.id),
      state: stateFromAgentSession(event.agentSession),
    },
  );
}

async function resolvePromptResponses(input: {
  readonly body: string;
  readonly config: LinearChannelConfig;
  readonly event: LinearAgentSessionEvent;
}): Promise<readonly InputResponse[]> {
  try {
    const activities = await listLinearAgentSessionActivities({
      api: input.config.api,
      credentials: input.config.credentials,
      agentSessionId: input.event.agentSession.id,
      last: 20,
    });
    return resolveLinearPromptInputResponses({ activities, body: input.body });
  } catch (error) {
    log.warn("linear HITL activity lookup failed — treating prompt as a message", { error });
    return [];
  }
}

async function resolveReceiveSession(
  target: Record<string, unknown>,
  config: LinearChannelConfig,
): Promise<LinearAgentSessionRecord> {
  if (hasString(target, "agentSessionId")) {
    return { id: target.agentSessionId };
  }
  if (hasString(target, "issueId")) {
    return createLinearAgentSessionOnIssue({
      api: config.api,
      credentials: config.credentials,
      externalLink: readString(target.externalLink),
      externalUrls: readExternalUrls(target.externalUrls),
      issueId: target.issueId,
    });
  }
  if (hasString(target, "commentId")) {
    return createLinearAgentSessionOnComment({
      api: config.api,
      credentials: config.credentials,
      commentId: target.commentId,
      externalLink: readString(target.externalLink),
      externalUrls: readExternalUrls(target.externalUrls),
    });
  }
  throw new Error("linearChannel().receive requires target.agentSessionId, issueId, or commentId.");
}

function stateFromAgentSession(
  session: LinearAgentSessionRef | LinearAgentSessionRecord,
): LinearChannelState {
  return {
    agentSessionId: session.id,
    agentSessionUrl: session.url ?? null,
    commentId: session.commentId ?? null,
    issueId: session.issueId ?? session.issue?.id ?? null,
    issueIdentifier: session.issue?.identifier ?? null,
    issueTitle: session.issue?.title ?? null,
    issueUrl: session.issue?.url ?? null,
    organizationId: session.organizationId ?? null,
    pendingToolCallMessage: null,
    sourceCommentId: session.sourceCommentId ?? null,
  };
}

function initialLinearState(): LinearChannelState {
  return {
    agentSessionId: null,
    agentSessionUrl: null,
    commentId: null,
    issueId: null,
    issueIdentifier: null,
    issueTitle: null,
    issueUrl: null,
    organizationId: null,
    pendingToolCallMessage: null,
    sourceCommentId: null,
  };
}

async function verifyInbound(
  req: Request,
  credentials: LinearChannelCredentials | undefined,
): Promise<string | null> {
  try {
    return await verifyLinearRequest(req, {
      webhookSecret: credentials?.webhookSecret,
      webhookVerifier: credentials?.webhookVerifier,
    });
  } catch (error) {
    log.warn("linear inbound verification failed", { error });
    return null;
  }
}

function hasString<T extends string>(
  value: Record<string, unknown>,
  key: T,
): value is Record<string, unknown> & Record<T, string> {
  return typeof value[key] === "string" && value[key].length > 0;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readExternalUrls(
  value: unknown,
): readonly { readonly label: string; readonly url: string }[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const urls = value.filter(
    (entry): entry is { readonly label: string; readonly url: string } =>
      isObject(entry) && typeof entry.label === "string" && typeof entry.url === "string",
  );
  return urls.length > 0 ? urls : undefined;
}

function jsonOk(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json; charset=utf-8" },
    status: 200,
  });
}
