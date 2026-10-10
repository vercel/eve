import type { SessionEvent } from "#protocol/session-event.js";
import type { ChannelAdapter, ChannelInstrumentationMetadata } from "#channel/adapter.js";
import {
  createMetadataAudienceProjector,
  type ChannelAudienceProjector,
} from "#channel/audience.js";
import { defaultDeliverResult } from "#channel/adapter.js";
import {
  CHANNEL_SENTINEL,
  type ChannelReference,
  type CompiledChannel,
} from "#channel/compiled-channel.js";
import { normalizeChannelCors, type ChannelCorsOptions } from "#channel/cors.js";
import { HTTP_ADAPTER_KIND } from "#channel/http.js";
import type {
  ChannelFrom,
  ChannelReceiveContext,
  ChannelResolveSession,
  ChannelRespondOptions,
  ChannelSendOptions,
  ChannelSource,
} from "#channel/channel-operations.js";
import type { RouteDefinition } from "#channel/routes.js";
import type { Session, SessionHandle } from "#channel/session.js";
import type { DeliverPayload, TurnPolicy } from "#channel/types.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
import type { SessionContext } from "#public/definitions/callback-context.js";
import type { FactPosition, Scope } from "#protocol/session-events/envelope.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
import { currentView } from "#harness/session-machine/current.js";
import { removedEventKeyMessage } from "#public/definitions/removed-event-keys.js";
import type { GenericChannelDefinition, GenericReceiveInput } from "#shared/channel-definition.js";

declare const CHANNEL_METADATA_TYPE: unique symbol;

export type {
  CancelTurnResult,
  ClearSessionResult,
  CompactSessionResult,
  GetEventStreamOptions,
  ResetSessionResult,
  SessionCallback,
  TurnPolicy,
} from "#channel/types.js";
export { SessionStrandedError } from "#channel/session-stranded-error.js";
export type { Session, SessionHandle } from "#channel/session.js";
export type { ChannelAudience } from "#shared/channel-audience.js";
export type {
  AudienceCaller,
  AudienceContext,
  AudienceInput,
  AudiencePrincipal,
  ConversationEnvironment,
} from "#shared/conversation-context.js";
export type { SessionRespondOptions, SessionSendOptions } from "#channel/session.js";
export type {
  ChannelFrom,
  ChannelReceiveContext,
  ChannelResolveSession,
  ChannelRespondOptions,
  ChannelSendOptions,
  ChannelSource,
};
export type { ChannelCors, ChannelCorsOptions } from "#channel/cors.js";
export type {
  AgentDescription,
  AgentSkillDescription,
  AgentSkillFileDescription,
  AgentToolDescription,
} from "#channel/agent-description.js";
export type { InvokeToolFn, InvokeToolOptions, InvokeToolResult } from "#channel/invoke-tool.js";
export { DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT, WS } from "#channel/routes.js";
export type {
  AttachSessionFn,
  HttpRouteDefinition,
  RouteDefinition,
  RouteHandlerArgs,
  WebSocketMessage,
  WebSocketPeer,
  WebSocketRouteDefinition,
  WebSocketRouteHandler,
  WebSocketRouteHooks,
  WebSocketUpgradeRequest,
  WebSocketUpgradeResult,
} from "#channel/routes.js";

/**
 * HTTP method a route handles. Defaults to `"POST"` — almost every route
 * is a webhook. Override only when authoring a non-webhook route such as a
 * long-poll endpoint or an event-stream reader.
 */
export type ChannelMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";

/**
 * Method-like discriminator used by compiled channel route entries.
 *
 * WebSocket routes are not HTTP methods, but they still need a stable
 * route key in the compiler manifest and runtime route table.
 */
export type ChannelRouteMethod = ChannelMethod | "WEBSOCKET";

/**
 * Per-request surface exposed to a route's `fetch` handler. The
 * framework constructs this per request and passes it as the second
 * argument.
 *
 * Framework callback routes use this for request metadata and background work.
 */
export interface RouteContext {
  /**
   * Hands a background promise to the request host so the serverless
   * invocation stays alive until the promise resolves. Use this when the
   * route responds to the platform immediately (e.g. a Slack `200 OK`
   * acknowledgement) but still needs to finish background work.
   */
  readonly waitUntil: (task: Promise<unknown>) => void;
  /**
   * Path parameter values extracted from `[name]` segments in the route's
   * filesystem path. For `agent/channels/sessions/[sessionId]/stream.ts`
   * mounted at `GET /sessions/:sessionId/stream`, the matched value lives at
   * `params.sessionId`.
   * Empty for routes with no path parameters.
   */
  readonly params: Readonly<Record<string, string>>;
  /**
   * Trusted peer IP for this request, extracted by the host transport
   * before the route handler runs. `null` when the host can't observe a
   * peer address (e.g. unit tests calling `route.fetch` directly).
   *
   * Pass this to {@link isIpAllowed} from `eve/channels/auth`
   * when implementing IP allowlisting in a route.
   */
  readonly requestIp: string | null;
}

/**
 * Marker discriminator written into every {@link DisabledRouteSentinel}.
 */
const DISABLED_ROUTE_SENTINEL_KIND = "eve:disabled-channel";

/**
 * Marker value returned from {@link disableRoute}. Export this as the
 * default export of a file in `agent/channels/` to remove the framework
 * default route whose logical name matches the file's slug path.
 */
export interface DisabledRouteSentinel {
  readonly kind: typeof DISABLED_ROUTE_SENTINEL_KIND;
}

/**
 * Returns a sentinel that disables the framework route whose logical name
 * matches the containing file's slug path.
 *
 * Export it as the default export of a file in `agent/channels/`.
 */
export function disableRoute(): DisabledRouteSentinel {
  return {
    kind: DISABLED_ROUTE_SENTINEL_KIND,
  };
}

/**
 * Type guard: returns whether `value` is a {@link DisabledRouteSentinel}
 * produced by {@link disableRoute}.
 */
export function isDisabledRouteSentinel(value: unknown): value is DisabledRouteSentinel {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === DISABLED_ROUTE_SENTINEL_KIND
  );
}

type EventData<T extends SessionEvent["type"]> =
  Extract<SessionEvent, { type: T }> extends { data: infer D } ? D : undefined;

/** Continuation routing on the `channel` argument of every channel event handler. */
export interface ChannelContinuationOps {
  readonly continuation?: {
    readonly token: string;
    alias(token: string): void;
  };
}

/**
 * Channel context passed to event handlers: `TCtx` intersected with
 * {@link ChannelContinuationOps}.
 */
type ChannelContext<TCtx> = TCtx & ChannelContinuationOps;

/**
 * What a channel event handler knows about the event it observes, beyond the session: where the
 * event sits on the stream. Observer-only, so tools never see it.
 */
export interface ChannelEventContext extends SessionContext {
  /** The position of the event's line, and its index in that line. */
  readonly position: FactPosition;
  /** The session's tables as of the whole commit the event is in. */
  readonly view: SessionView;
  /** The event's owners: its turn, task, model run, or context change. */
  readonly scope?: Scope;
}

type ChannelEventHandler<T extends SessionEvent["type"], TCtx> = (
  data: EventData<T>,
  channel: ChannelContext<TCtx>,
  ctx: ChannelEventContext,
) => void | Promise<void>;

/**
 * Optional handlers keyed by session event type: the session's facts, the progress records a
 * channel streams (`content.delta`, `call.input`, `call.progress`), and the work events not yet
 * moved to facts. Each handler receives the event `data`, the {@link ChannelContext}, and a
 * {@link ChannelEventContext} `ctx`. Handlers run after the event is written, so they observe it
 * and never shape it.
 */
export interface ChannelEvents<TCtx = void> {
  readonly "session.started"?: ChannelEventHandler<"session.started", TCtx>;
  readonly "session.ended"?: ChannelEventHandler<"session.ended", TCtx>;
  readonly "delivery.admitted"?: ChannelEventHandler<"delivery.admitted", TCtx>;
  readonly "delivery.consumed"?: ChannelEventHandler<"delivery.consumed", TCtx>;
  readonly "delivery.settled"?: ChannelEventHandler<"delivery.settled", TCtx>;
  readonly "turn.started"?: ChannelEventHandler<"turn.started", TCtx>;
  readonly "turn.paused"?: ChannelEventHandler<"turn.paused", TCtx>;
  readonly "turn.resumed"?: ChannelEventHandler<"turn.resumed", TCtx>;
  readonly "turn.settled"?: ChannelEventHandler<"turn.settled", TCtx>;
  readonly "model.requested"?: ChannelEventHandler<"model.requested", TCtx>;
  readonly "model.started"?: ChannelEventHandler<"model.started", TCtx>;
  readonly "model.settled"?: ChannelEventHandler<"model.settled", TCtx>;
  readonly "content.delta"?: ChannelEventHandler<"content.delta", TCtx>;
  readonly "content.completed"?: ChannelEventHandler<"content.completed", TCtx>;
  readonly "call.input"?: ChannelEventHandler<"call.input", TCtx>;
  readonly "call.requested"?: ChannelEventHandler<"call.requested", TCtx>;
  readonly "call.started"?: ChannelEventHandler<"call.started", TCtx>;
  readonly "call.progress"?: ChannelEventHandler<"call.progress", TCtx>;
  readonly "call.settled"?: ChannelEventHandler<"call.settled", TCtx>;
  readonly "usage.recorded"?: ChannelEventHandler<"usage.recorded", TCtx>;
  readonly "context.started"?: ChannelEventHandler<"context.started", TCtx>;
  readonly "context.settled"?: ChannelEventHandler<"context.settled", TCtx>;
  readonly "agent.started"?: ChannelEventHandler<"agent.started", TCtx>;
  readonly "approval.candidate"?: ChannelEventHandler<"approval.candidate", TCtx>;
  readonly "approval.settled"?: ChannelEventHandler<"approval.settled", TCtx>;
  readonly "authorization.required"?: ChannelEventHandler<"authorization.required", TCtx>;
  readonly "authorization.completed"?: ChannelEventHandler<"authorization.completed", TCtx>;
  readonly "input.requested"?: ChannelEventHandler<"input.requested", TCtx>;
  readonly "input.resolved"?: ChannelEventHandler<"input.resolved", TCtx>;
  readonly "task.started"?: ChannelEventHandler<"task.started", TCtx>;
  readonly "task.settled"?: ChannelEventHandler<"task.settled", TCtx>;
}

/**
 * Input passed to a channel's `receive` callback when another channel or
 * schedule proactively routes a message to it.
 */
export type ReceiveInput<TReceiveTarget = Record<string, unknown>> =
  GenericReceiveInput<TReceiveTarget>;

/**
 * The object passed to {@link defineChannel}. `routes` is required; `state`
 * seeds durable adapter state, `context` builds the per-step `channel` argument
 * for `events` and `deliver`, `events` handle session lifecycle, `receive`
 * accepts cross-channel handoffs, `fetchFile` stages remote file URLs, and
 * `metadata` projects observability data.
 *
 * Generics: `TState` (adapter state), `TCtx` (context factory return type),
 * `TReceiveTarget` (cross-channel target shape), `TMetadata` (instrumentation
 * projection).
 */
export type ChannelDefinition<
  TState = undefined,
  TCtx = void,
  TReceiveTarget = Record<string, unknown>,
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> = GenericChannelDefinition<ChannelEvents<TCtx>, TState, TCtx, TReceiveTarget, TMetadata>;

/**
 * Opaque channel value produced by {@link defineChannel} and exported from
 * `agent/channels/<name>.ts`. Exposes the channel's routes, an optional
 * `receive` hook, and (via a phantom property) its metadata shape. Unlike
 * {@link ChannelDefinition} it has no `TCtx` parameter: the context type is
 * internal to the definition.
 */
export interface Channel<
  TState = undefined,
  TReceiveTarget = Record<string, unknown>,
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> extends ChannelReference<TReceiveTarget> {
  readonly [CHANNEL_METADATA_TYPE]?: TMetadata;
  readonly routes: readonly RouteDefinition<TState>[];
  readonly cors?: ChannelCorsOptions;
  readonly receive?: (
    input: ReceiveInput<TReceiveTarget>,
    ctx: ChannelReceiveContext<TState>,
  ) => Promise<Session>;
  readonly turnPolicy?: TurnPolicy;
}

/**
 * Extracts the metadata projection type (`TMetadata`) from a {@link Channel}.
 * Resolves to `Record<string, unknown>` when the value is not a Channel.
 */
export type InferChannelMetadata<TChannel> =
  TChannel extends Channel<any, any, infer TMetadata> ? TMetadata : Record<string, unknown>;

/**
 * Builds a {@link Channel} from a {@link ChannelDefinition}. Returns a value
 * placed at `agent/channels/<name>.ts`; the file path supplies the channel name
 * (do not add a `name` field). `TCtx` (the context factory's return type) is
 * internal to the definition and is not part of the returned Channel signature.
 */
export function defineChannel<
  TState = undefined,
  TCtx = void,
  TReceiveTarget = Record<string, unknown>,
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
>(
  definition: ChannelDefinition<TState, TCtx, TReceiveTarget, TMetadata>,
): Channel<TState, TReceiveTarget, TMetadata> {
  const adapter = buildAdapter(definition);
  const cors = normalizeChannelCors(definition.cors);

  const compiled: CompiledChannel<TState, TReceiveTarget, TMetadata> = {
    __kind: CHANNEL_SENTINEL,
    routes: definition.routes,
    adapter,
    cors,
    receive: definition.receive,
    turnPolicy: definition.turnPolicy,
  };

  return compiled;
}

// The Record type fails to compile if this map drifts from the ChannelEvents
// keys in either direction.
const channelEventTypes: Record<keyof ChannelEvents, null> = {
  "session.started": null,
  "session.ended": null,
  "delivery.admitted": null,
  "delivery.consumed": null,
  "delivery.settled": null,
  "turn.started": null,
  "turn.paused": null,
  "turn.resumed": null,
  "turn.settled": null,
  "model.requested": null,
  "model.started": null,
  "model.settled": null,
  "content.delta": null,
  "content.completed": null,
  "call.input": null,
  "call.requested": null,
  "call.started": null,
  "call.progress": null,
  "call.settled": null,
  "usage.recorded": null,
  "context.started": null,
  "context.settled": null,
  "agent.started": null,
  "approval.candidate": null,
  "approval.settled": null,
  "authorization.required": null,
  "authorization.completed": null,
  "input.requested": null,
  "input.resolved": null,
  "task.started": null,
  "task.settled": null,
};

const eventTypes = Object.keys(channelEventTypes) as readonly (keyof ChannelEvents)[];

function buildAdapter<TState, TCtx, TReceiveTarget, TMetadata extends Record<string, unknown>>(
  definition: ChannelDefinition<TState, TCtx, TReceiveTarget, TMetadata>,
): ChannelAdapter<any> {
  const hasState = definition.state != null;
  const hasContext = definition.context != null;
  const hasFetchFile = definition.fetchFile !== undefined;
  const metadata = definition.metadata;
  const hasMetadata = metadata !== undefined;
  const audience = definition.audience;
  const hasBehavior = hasState || hasContext || hasMetadata;

  const eventHandlers: Record<string, unknown> = {};
  let hasEventHandlers = false;
  const legacyAudienceSource = {
    kind: definition.kindHint ?? "defineChannel",
  };

  const events = definition.events;
  for (const key of Object.keys(events ?? {})) {
    const removed = removedEventKeyMessage(key);
    if (removed !== undefined) throw new Error(`A channel handles ${removed}`);
  }
  for (const eventType of eventTypes) {
    const userHandler = events?.[eventType];
    if (userHandler) {
      hasEventHandlers = true;
      eventHandlers[eventType] = (data: unknown, adapterCtx: any) => {
        const { session, position, scope, ...platformContext } = adapterCtx;
        const channel = {
          ...platformContext,
          continuation:
            session?.continuation === undefined
              ? undefined
              : {
                  token: session.continuation.token,
                  alias: (token: string) => session.continuation?.alias(token),
                },
        };
        const ctx: ChannelEventContext = {
          ...buildCallbackContext(),
          position: position ?? { index: 0, line: 0 },
          scope,
          view: currentView(),
        };
        return (
          userHandler as (
            data: unknown,
            channel: any,
            ctx: ChannelEventContext,
          ) => void | Promise<void>
        )(data, channel, ctx);
      };
    }
  }

  if (!hasBehavior && !hasEventHandlers && !hasFetchFile) {
    return {
      kind: definition.kindHint ?? HTTP_ADAPTER_KIND,
      ...(audience === undefined
        ? undefined
        : {
            instrumentation: {
              audience: audience as ChannelAudienceProjector,
            },
          }),
    } as ChannelAdapter<any>;
  }

  const adapter: ChannelAdapter<any> = {
    kind: definition.kindHint ?? "defineChannel",
    state: hasState ? { ...(definition.state as Record<string, unknown>) } : {},
    fetchFile: definition.fetchFile,
    instrumentation:
      metadata === undefined && audience === undefined
        ? undefined
        : {
            ...(metadata === undefined
              ? undefined
              : {
                  metadata(state): ChannelInstrumentationMetadata {
                    const projected = metadata(state as NonNullable<TState>) as Record<
                      string,
                      unknown
                    >;
                    const { audience: _ignoredAudience, ...customMetadata } = projected;
                    return customMetadata;
                  },
                }),
            ...(audience === undefined
              ? metadata !== undefined
                ? {
                    audience: createMetadataAudienceProjector(
                      legacyAudienceSource,
                      metadata as (state: Record<string, unknown> | undefined) => unknown,
                    ),
                  }
                : undefined
              : { audience: audience as ChannelAudienceProjector }),
          },

    createAdapterContext(base): any {
      const state = base.state;
      const session = base.session;
      const channelCtx = hasContext
        ? (definition.context as (s: any, session: SessionHandle) => any)(state, session)
        : {};

      return {
        ...channelCtx,
        state,
        ctx: base.ctx,
        session,
      };
    },

    deliver(payload: DeliverPayload, adapterCtx) {
      if (definition.deliver === undefined) return defaultDeliverResult(payload);
      return definition.deliver(payload, adapterCtx as TCtx);
    },

    ...eventHandlers,
  } as ChannelAdapter<any>;

  return adapter;
}
