import { type ChannelCors } from "#channel/cors.js";
import type { MessageContent } from "#shared/message-content.js";
import type { ChannelReceiveContext } from "#channel/channel-operations.js";
import type { RouteDefinition } from "#channel/routes.js";
import type { ChannelContext } from "#shared/channel-context.js";
import type { Delivery } from "#shared/delivery.js";
import type { SessionAuthContext, TurnPolicy } from "#channel/types.js";
import type { ChannelDelivery, ChannelDeliveryReplacement } from "#shared/channel-delivery.js";
import type { UploadPolicyInput } from "#public/channels/upload-policy.js";
import type { AudienceContext } from "#shared/conversation-context.js";
import type { ChannelAudience } from "#shared/channel-audience.js";

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

/** Runtime context supplied while resolving a channel-owned file URL. */
export interface FetchFileContext {
  readonly state: Readonly<Record<string, unknown>>;
  /** The session the attachment arrived in, for checking it against the session's caller. */
  readonly session: ChannelContext["session"];
}

export type FetchFileFunction = (
  url: string,
  context?: FetchFileContext,
) => Promise<Buffer | FetchFileResult | null>;

/**
 * Input passed to a channel's `receive` callback when another channel or
 * schedule proactively routes a message to it.
 */
export interface GenericReceiveInput<TReceiveTarget = Record<string, unknown>> {
  readonly message: MessageContent;
  readonly target: Readonly<TReceiveTarget>;
  readonly auth: SessionAuthContext | null;
}

/**
 * The object passed to {@link defineChannel}. `routes` is required; `state`
 * seeds durable adapter state, `context` builds the per-step `ctx.channel`
 * for `events` and `deliver`, `events` handle session lifecycle, `receive`
 * accepts cross-channel handoffs, `fetchFile` stages remote file URLs,
 * `audience` classifies conversation visibility, and `metadata` projects
 * custom observability data.
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
  /** Policy used by message sends that do not provide an explicit override. */
  readonly turnPolicy?: TurnPolicy;
  /**
   * Return a replacement delivery, or void to deliver the original payload unchanged. A
   * replacement carries no `state`; change durable channel state through `ctx.state`.
   */
  deliver?(
    payload: ChannelDelivery<TState>,
    ctx: TCtx & ChannelContext,
  ): ChannelDeliveryReplacement | void | Promise<ChannelDeliveryReplacement | void>;
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
   * Receives live session information and channel continuation routing, so a factory can
   * register late-bound callbacks. eve writes state mutations made inside the
   * returned context back through `adapter.state`.
   *
   * Return the channel-owned context (thread handles, API clients, etc.). An
   * event handler reads it as `ctx.channel`, with continuation routing added,
   * beside the session's context.
   */
  context?(state: NonNullable<TState>, channel: ChannelContext): TCtx;

  readonly routes: readonly RouteDefinition<TState>[];
  receive?(
    input: GenericReceiveInput<TReceiveTarget>,
    ctx: ChannelReceiveContext<TState>,
  ): Promise<Delivery>;

  readonly events?: TEvents;

  /**
   * Fetches bytes for a link encountered on a `FilePart.data` by the staging
   * pipeline. Return bytes / {@link FetchFileResult} to stage the file to the
   * sandbox, or `null` when the link is not this channel's: eve then downloads
   * a public `https:` link itself, and any other link reaches the model as a
   * note. A provider never fetches an attachment.
   */
  readonly fetchFile?: FetchFileFunction;

  /**
   * Size cap and media types for every file eve stages for this channel,
   * checked against the final bytes and the media type they prove, including
   * links eve downloads itself. A file that breaks the policy reaches the
   * model as a note. Omit to check nothing beyond your own `fetchFile`; eve's
   * own downloads then stop at the 25 MB framework default.
   */
  readonly uploadPolicy?: UploadPolicyInput;

  /**
   * Channel-owned metadata exposed to instrumentation callbacks. This is the
   * channel's public observability surface, not a dump of durable adapter state,
   * so keep it small. Return an object of JSON primitives, arrays, and plain
   * objects: eve omits `undefined` properties and drops projections containing
   * values such as `Date` or `Map`.
   */
  readonly metadata?: (state: NonNullable<TState>) => TMetadata;

  /**
   * Classifies who can observe the originating conversation. The hook runs
   * after route auth with channel state, the authenticated principal, and
   * deployment environment. Return `"unknown"` when classification is not
   * confident; consumers treat it as non-public.
   */
  readonly audience?: (input: AudienceContext<TState>) => ChannelAudience;
}
