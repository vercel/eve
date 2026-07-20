import { type ChannelCors } from "#channel/cors.js";
import type { RouteDefinition, SendFn } from "#channel/routes.js";
import type { Session, SessionHandle } from "#channel/session.js";
import type { SessionAuthContext } from "#channel/types.js";

/**
 * Enriched return shape from a channel's {@link ChannelAdapter.fetchFile}
 * function. Return a bare {@link Buffer} when only bytes are known, or
 * this record when the fetch discovers a more accurate `mediaType` or
 * `filename` (e.g. from an HTTP `Content-Type` header).
 *
 * When fields are provided, staging prefers them over the values the
 * channel populated at ingestion time.
 */
export interface FetchFileResult {
  readonly bytes: Buffer;
  readonly mediaType?: string;
  readonly filename?: string;
}

export type FetchFileFunction = (url: string) => Promise<Buffer | FetchFileResult | null>;

/**
 * Input passed to a channel's `receive` callback when another channel or
 * schedule proactively routes a message to it.
 */
export interface GenericReceiveInput<TReceiveTarget = Record<string, unknown>> {
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
export interface GenericChannelDefinition<
  TEvents,
  TState = undefined,
  TCtx = void,
  TReceiveTarget = Record<string, unknown>,
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly state?: TState;
  /**
   * CORS policy for this channel's HTTP routes. `true` enables H3/Nitro's
   * permissive defaults (`origin`, methods, request headers, and exposed
   * headers all `"*"`); `false` or omission leaves CORS untouched. Pass an
   * object for a serializable subset of H3/Nitro CORS options.
   */
  readonly cors?: ChannelCors;
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
  receive?(
    input: GenericReceiveInput<TReceiveTarget>,
    args: { send: SendFn<TState> },
  ): Promise<Session>;

  readonly events?: TEvents;

  /**
   * Fetches bytes for a `URL` object encountered on a `FilePart.data` by the
   * staging pipeline. Return `null` to pass the URL through to the model
   * provider unchanged, or bytes / {@link FetchFileResult} to stage the file to
   * the sandbox.
   */
  readonly fetchFile?: FetchFileFunction;

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
