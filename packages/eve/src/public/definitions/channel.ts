import type { ChannelAdapter, ChannelInstrumentationMetadata } from "#channel/adapter.js";
import { defaultDeliverResult } from "#channel/adapter.js";
import { CHANNEL_SENTINEL, type CompiledChannel } from "#channel/compiled-channel.js";
import { normalizeChannelCors, type ChannelCorsOptions } from "#channel/cors.js";
import { HTTP_ADAPTER_KIND } from "#channel/http.js";
import type { TypedReceiveTarget } from "#channel/receive-target.js";
import type { RouteDefinition, SendFn } from "#channel/routes.js";
import type { Session, SessionHandle } from "#channel/session.js";
import type {
  DeliverInput,
  DeliverPayload,
  GetEventStreamOptions,
  RunHandle,
  RunInput,
} from "#channel/types.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import type { SessionContext } from "#public/definitions/callback-context.js";
import type { GenericChannelDefinition, GenericReceiveInput } from "#shared/channel-definition.js";

declare const CHANNEL_METADATA_TYPE: unique symbol;

export type { GetEventStreamOptions } from "#channel/types.js";
export type { Session, SessionHandle } from "#channel/session.js";
export type { ChannelCors, ChannelCorsOptions } from "#channel/cors.js";
export { GET, POST, PUT, PATCH, DELETE, WS } from "#channel/routes.js";
export type {
  HttpRouteDefinition,
  RouteDefinition,
  RouteHandlerArgs,
  SendFn,
  SendOptions,
  SendPayload,
  GetSessionFn,
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
export type ChannelMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

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
 * Routes call into the agent to start new sessions (`agent.run`),
 * deliver follow-up messages to existing sessions (`agent.deliver`), or
 * read events from a previously-started session (`agent.getEventStream`).
 */
export interface RouteContext {
  /**
   * Handle to the agent that this route sends inbound requests to.
   * Conceptually the runtime + harness combined: routes call `run`,
   * `deliver`, and `getEventStream` to drive sessions of this agent
   * without knowing about the workflow runtime, the harness, or any
   * other execution-layer detail.
   *
   * Every route speaks the same `RunInput` shape regardless of which
   * webhook it serves — `agent` is platform-agnostic.
   */
  readonly agent: Agent;
  /**
   * Hands a background promise to the request host so the serverless
   * invocation stays alive until the promise resolves. Use this when the
   * route responds to the platform immediately (e.g. a Slack `200 OK`
   * acknowledgement) but still needs to drive an `agent.run()` call to
   * completion.
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
 * Route-facing handle to the agent that owns this request.
 *
 * `Agent` is conceptually the workflow runtime plus the tool-loop harness:
 * routes call `run` to start a new session of the agent, `deliver` to
 * send a follow-up to a parked session, and `getEventStream` to read events
 * from a previously-started session. The framework's internal `Runtime`
 * interface (in `channel/types.ts`) is the underlying primitive — `Agent`
 * is the *public* shape exposed on `RouteContext` so route authors
 * speak in terms of the agent rather than the runtime.
 */
export interface Agent {
  /**
   * Starts a new agent session and returns a handle. The session's identity
   * is the supplied `continuationToken` — subsequent calls to `deliver()`
   * with the same token resume the same session.
   */
  run(input: RunInput): Promise<RunHandle>;
  /**
   * Sends a follow-up message to a session that is currently parked waiting
   * for input. Throws if no parked session exists for the supplied
   * `continuationToken` — routes typically catch the failure and fall back
   * to `run()` to start a new session.
   */
  deliver(input: DeliverInput): Promise<{ sessionId: string }>;
  /**
   * Returns a readable NDJSON-style stream of lifecycle events for an
   * existing session. Used by the framework's HTTP session-stream route and by
   * any user-authored route that exposes an event-streaming endpoint.
   *
   * Nonnegative `options.startIndex` values skip events the caller has already
   * consumed. Negative values read relative to the current tail (`-1` starts
   * at the latest event). The framework HTTP session-stream route forwards
   * the `startIndex` query parameter unchanged.
   */
  getEventStream(
    sessionId: string,
    options?: GetEventStreamOptions,
  ): Promise<ReadableStream<HandleMessageStreamEvent>>;
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

type EventData<T extends HandleMessageStreamEvent["type"]> =
  Extract<HandleMessageStreamEvent, { type: T }> extends { data: infer D } ? D : undefined;

/**
 * Session operations on the `channel` argument of every channel event handler.
 */
export interface ChannelSessionOps {
  readonly continuationToken: string;
  setContinuationToken(token: string): void;
}

/**
 * Channel context passed to event handlers: `TCtx` intersected with
 * {@link ChannelSessionOps}.
 */
export type ChannelContext<TCtx> = TCtx & ChannelSessionOps;

type ChannelEventHandler<T extends HandleMessageStreamEvent["type"], TCtx> = (
  data: EventData<T>,
  channel: ChannelContext<TCtx>,
  ctx: SessionContext,
) => void | Promise<void>;

type ChannelSessionFailedHandler<TCtx> = (
  data: EventData<"session.failed">,
  channel: ChannelContext<TCtx>,
) => void | Promise<void>;

/**
 * Optional handlers keyed by session lifecycle event name. Each handler receives
 * the event `data`, the {@link ChannelContext}, and a {@link SessionContext}
 * `ctx`. The `session.failed` handler is the exception: it receives only `data`
 * and the channel context, with no `ctx`.
 */
export interface ChannelEvents<TCtx = void> {
  readonly "turn.started"?: ChannelEventHandler<"turn.started", TCtx>;
  readonly "actions.requested"?: ChannelEventHandler<"actions.requested", TCtx>;
  readonly "action.result"?: ChannelEventHandler<"action.result", TCtx>;
  readonly "message.completed"?: ChannelEventHandler<"message.completed", TCtx>;
  readonly "message.appended"?: ChannelEventHandler<"message.appended", TCtx>;
  readonly "reasoning.appended"?: ChannelEventHandler<"reasoning.appended", TCtx>;
  readonly "reasoning.completed"?: ChannelEventHandler<"reasoning.completed", TCtx>;
  readonly "input.requested"?: ChannelEventHandler<"input.requested", TCtx>;
  readonly "turn.failed"?: ChannelEventHandler<"turn.failed", TCtx>;
  readonly "turn.completed"?: ChannelEventHandler<"turn.completed", TCtx>;
  readonly "turn.cancelled"?: ChannelEventHandler<"turn.cancelled", TCtx>;
  readonly "session.failed"?: ChannelSessionFailedHandler<TCtx>;
  readonly "session.completed"?: ChannelEventHandler<"session.completed", TCtx>;
  readonly "session.waiting"?: ChannelEventHandler<"session.waiting", TCtx>;
  readonly "authorization.required"?: ChannelEventHandler<"authorization.required", TCtx>;
  readonly "authorization.completed"?: ChannelEventHandler<"authorization.completed", TCtx>;
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
> extends TypedReceiveTarget<TReceiveTarget> {
  readonly __kind: typeof CHANNEL_SENTINEL;
  readonly [CHANNEL_METADATA_TYPE]?: TMetadata;
  readonly routes: readonly RouteDefinition<TState>[];
  readonly cors?: ChannelCorsOptions;
  readonly receive?: (
    input: ReceiveInput<TReceiveTarget>,
    args: { send: SendFn<TState> },
  ) => Promise<Session>;
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
  };

  return compiled;
}

// The Record type fails to compile if this map drifts from the ChannelEvents
// keys in either direction.
const channelEventTypes: Record<keyof ChannelEvents, null> = {
  "turn.started": null,
  "actions.requested": null,
  "action.result": null,
  "message.completed": null,
  "message.appended": null,
  "reasoning.appended": null,
  "reasoning.completed": null,
  "input.requested": null,
  "turn.failed": null,
  "turn.completed": null,
  "turn.cancelled": null,
  "session.failed": null,
  "session.completed": null,
  "session.waiting": null,
  "authorization.required": null,
  "authorization.completed": null,
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
  const hasBehavior = hasState || hasContext || hasMetadata;

  const eventHandlers: Record<string, unknown> = {};
  let hasEventHandlers = false;

  const events = definition.events;
  for (const eventType of eventTypes) {
    const userHandler = events?.[eventType];
    if (userHandler) {
      hasEventHandlers = true;
      eventHandlers[eventType] = (data: unknown, adapterCtx: any) => {
        const channel = {
          ...adapterCtx,
          continuationToken: adapterCtx.session?.continuationToken ?? "",
          setContinuationToken: (token: string) => adapterCtx.session?.setContinuationToken(token),
        };
        if (eventType === "session.failed") {
          return (userHandler as (data: unknown, channel: any) => void | Promise<void>)(
            data,
            channel,
          );
        }
        const ctx = buildCallbackContext();
        return (
          userHandler as (data: unknown, channel: any, ctx: SessionContext) => void | Promise<void>
        )(data, channel, ctx);
      };
    }
  }

  if (!hasBehavior && !hasEventHandlers && !hasFetchFile) {
    return { kind: definition.kindHint ?? HTTP_ADAPTER_KIND } as ChannelAdapter<any>;
  }

  const adapter: ChannelAdapter<any> = {
    kind: definition.kindHint ?? "defineChannel",
    state: hasState ? { ...(definition.state as Record<string, unknown>) } : {},
    fetchFile: definition.fetchFile,
    instrumentation:
      metadata === undefined
        ? undefined
        : {
            metadata(state): ChannelInstrumentationMetadata {
              return metadata(state as NonNullable<TState>);
            },
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

    deliver(payload: DeliverPayload) {
      return defaultDeliverResult(payload);
    },

    ...eventHandlers,
  } as ChannelAdapter<any>;

  return adapter;
}
