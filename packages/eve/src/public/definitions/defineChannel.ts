import type {
  ChannelAdapter,
  ChannelInstrumentationMetadata,
  FetchFileResult,
} from "#channel/adapter.js";
import { CHANNEL_SENTINEL, type CompiledChannel } from "#channel/compiled-channel.js";
import { defaultDeliverResult } from "#channel/adapter.js";
import { HTTP_ADAPTER_KIND } from "#channel/http.js";
import type { TypedReceiveTarget } from "#channel/receive-target.js";
import type { DeliverPayload, SessionAuthContext } from "#channel/types.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import type { SessionContext } from "#public/definitions/callback-context.js";
import type { RouteDefinition, SendFn } from "#channel/routes.js";
import type { Session, SessionHandle } from "#channel/session.js";

declare const CHANNEL_METADATA_TYPE: unique symbol;

export type { Session, SessionHandle } from "#channel/session.js";
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
export interface ReceiveInput<TReceiveTarget = Record<string, unknown>> {
  readonly message: string;
  readonly target: Readonly<TReceiveTarget>;
  readonly auth: SessionAuthContext | null;
}

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
export interface ChannelDefinition<
  TState = undefined,
  TCtx = void,
  TReceiveTarget = Record<string, unknown>,
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly state?: TState;
  /**
   * Builds the per-step channel context handed to `events` and `deliver`.
   * Receives the live {@link SessionHandle}, so a factory can close over it to
   * register late-bound callbacks. eve writes state mutations made inside the
   * returned context back through `adapter.state`.
   *
   * Return the channel-owned context (thread handles, API clients, etc.). The
   * framework passes it as the `channel` argument to event handlers (with
   * {@link ChannelSessionOps} injected) and passes {@link SessionContext} as a
   * separate `ctx` argument.
   */
  context?(state: NonNullable<TState>, session: SessionHandle): TCtx;

  readonly routes: readonly RouteDefinition<TState>[];
  receive?(input: ReceiveInput<TReceiveTarget>, args: { send: SendFn<TState> }): Promise<Session>;

  readonly events?: ChannelEvents<TCtx>;

  /**
   * Fetches bytes for a `URL` object encountered on a `FilePart.data` by the
   * staging pipeline. Return `null` to pass the URL through to the model
   * provider unchanged, or bytes / {@link FetchFileResult} to stage the file to
   * the sandbox.
   */
  readonly fetchFile?: (url: string) => Promise<Buffer | FetchFileResult | null>;

  /**
   * Channel-owned metadata exposed to instrumentation callbacks. This is the
   * channel's public observability surface, not a dump of durable adapter state,
   * so keep it small. Return an object of JSON primitives, arrays, and plain
   * objects: eve omits `undefined` properties and drops projections containing
   * values such as `Date` or `Map`.
   */
  readonly metadata?: (state: NonNullable<TState>) => TMetadata;

  /**
   * Identifier of the adapter family this channel belongs to. Set by
   * higher-level wrappers (e.g. `slackChannel` passes `"slack"`) so downstream
   * consumers can render typed channel chips instead of bucketing everything
   * under "unknown".
   *
   * Authors calling `defineChannel` directly do not need to set this; the
   * framework defaults to `"http"` for stateless channels and `"defineChannel"`
   * for stateful ones.
   */
  readonly kindHint?: string;
}

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

  const compiled: CompiledChannel<TState, TReceiveTarget, TMetadata> = {
    __kind: CHANNEL_SENTINEL,
    routes: definition.routes,
    adapter,
    receive: definition.receive,
  };

  return compiled;
}

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

  const eventTypes = [
    "turn.started",
    "actions.requested",
    "action.result",
    "message.completed",
    "message.appended",
    "reasoning.appended",
    "reasoning.completed",
    "input.requested",
    "turn.failed",
    "turn.completed",
    "session.failed",
    "session.completed",
    "session.waiting",
    "authorization.required",
    "authorization.completed",
  ] as const;

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
