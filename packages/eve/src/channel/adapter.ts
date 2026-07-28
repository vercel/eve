import type { ContextAccessor } from "#context/key.js";
import type { StepInput } from "#harness/types.js";
import { createLogger } from "#internal/logging.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import type { SessionHandle } from "#channel/session.js";
import type { DeliverPayload } from "#channel/types.js";
import type { FetchFileResult, FetchFileFunction } from "#shared/channel-definition.js";
import { toChannelLocalContinuationToken } from "#shared/continuation-token.js";

const log = createLogger("channel.adapter");

// ---------------------------------------------------------------------------
// Adapter context
// ---------------------------------------------------------------------------

/**
 * Context available to every adapter handler (`deliver` and event handlers).
 *
 * `state` is a mutable reference to the adapter's durable state. The runtime
 * auto-snapshots it at step boundaries — no manual `serialize()` needed.
 *
 * `ctx` provides read/write access to durable context keys (the same
 * {@link ContextAccessor} that tools and providers use).
 *
 * `session` is a live handle to the current session — id, auth,
 * continuation token, plus an imperative {@link SessionHandle.setContinuationToken}
 * for channels that need to re-key the session mid-turn (e.g. Slack's
 * auto-anchor on first post).
 */
export interface ChannelAdapterContext<TState = Record<string, unknown>> {
  /**
   * Mutable adapter state. Auto-serialized at step boundaries via
   * JSON snapshot. The adapter reads and writes this directly.
   */
  state: TState;

  /**
   * Read/write access to durable context keys. Seed keys here for tools
   * to read during the turn.
   */
  readonly ctx: ContextAccessor;

  /**
   * Live handle to the current session.
   */
  readonly session: SessionHandle;
}

/**
 * Extracts the state type from a {@link ChannelAdapterContext} generic.
 * Used internally so adapter-level types can declare their state shape
 * once (via `TCtx`) and have helpers narrow consistently.
 */
type StateOf<TCtx> = TCtx extends ChannelAdapterContext<infer S> ? S : Record<string, unknown>;

// ---------------------------------------------------------------------------
// Event handler types
// ---------------------------------------------------------------------------

/**
 * Extracts the `data` field type from a stream event by its `type` discriminant.
 * Events that carry no `data` field (e.g. `session.completed`) resolve to `undefined`.
 */
type EventData<T extends HandleMessageStreamEvent["type"]> =
  Extract<HandleMessageStreamEvent, { type: T }> extends { data: infer D } ? D : undefined;

/**
 * A single outbound event handler. Receives the event's `data` (not the full
 * envelope) and the adapter context. Void return — side effects only.
 */
type EventHandler<
  T extends HandleMessageStreamEvent["type"],
  TCtx extends ChannelAdapterContext<any> = ChannelAdapterContext,
> = (data: EventData<T>, ctx: TCtx) => void | Promise<void>;

/**
 * Map of outbound event handlers keyed by event type. The adapter declares
 * handlers for the event types it cares about. For undeclared types, the
 * framework's default handlers run.
 */
export type ChannelEventHandlers<TCtx extends ChannelAdapterContext<any> = ChannelAdapterContext> =
  {
    [K in HandleMessageStreamEvent["type"]]?: EventHandler<K, TCtx>;
  };

// ---------------------------------------------------------------------------
// File fetch
// ---------------------------------------------------------------------------

/**
 * Enriched return shape from a channel's {@link ChannelAdapter.fetchFile}
 * function. Return a bare {@link Buffer} when only bytes are known, or
 * this record when the fetch discovers a more accurate `mediaType` or
 * `filename` (e.g. from an HTTP `Content-Type` header).
 *
 * When fields are provided, staging prefers them over the values the
 * channel populated at ingestion time.
 */
export type { FetchFileResult };

export type ChannelInstrumentationMetadata = Readonly<Record<string, unknown>>;

export type ChannelInstrumentationMetadataProjector = (
  state: Record<string, unknown> | undefined,
) => ChannelInstrumentationMetadata;

// ---------------------------------------------------------------------------
// Channel adapter
// ---------------------------------------------------------------------------

/**
 * Plain-object channel adapter with durable state, an optional inbound
 * delivery hook, event handlers, and optional attachment resolution.
 */
export type ChannelAdapter<TCtx extends ChannelAdapterContext<any> = ChannelAdapterContext> = {
  /**
   * Stable durable identifier for serialization across step boundaries.
   * Must be unique across all adapters visible to one runtime bundle.
   *
   * Defaults to {@link HTTP_ADAPTER_KIND} (`"http"`) for the canonical
   * session channel and every behaviorless authored channel, or is derived
   * from the route file path as `channel:<name>` once
   * `runtime/resolve-channel.ts` rewrites authored adapters that carry
   * behavior.
   */
  readonly kind: string;

  /**
   * Initial state shape. Auto-serialized at step boundaries via JSON
   * snapshot. On rehydration, the runtime restores the serialized state
   * and re-attaches the adapter's behavior functions from the registry.
   */
  readonly state?: Record<string, unknown>;

  /**
   * Inbound hook: fires once per delivery before the harness starts.
   *
   * Return a {@link StepInput} to override the input the harness sees, or
   * return void to use the default payload projection.
   */
  deliver?(payload: DeliverPayload, ctx: TCtx): StepInput | void | Promise<StepInput | void>;

  /**
   * Optional factory that builds the adapter context for this adapter.
   *
   * @internal
   */
  createAdapterContext?(base: ChannelAdapterContext<StateOf<TCtx>>): TCtx;

  /**
   * Fetches bytes for a URL encountered in `FilePart.data`.
   *
   * Called by the staging pipeline when it encounters a `URL` object
   * on a `FilePart`. Return `null` to let the URL pass through to the
   * model provider (e.g. public images). Return bytes or
   * {@link FetchFileResult} to stage the file to the sandbox.
   *
   * Credentials should be captured in the closure at channel
   * construction time.
   */
  readonly fetchFile?: FetchFileFunction;

  /**
   * Framework-owned observability projection for the active channel.
   *
   * Channel implementations decide which state fields are safe and
   * meaningful to expose to instrumentation callbacks. The harness reads
   * the resulting projection through a seed context key rather than
   * inspecting adapter state directly.
   */
  readonly instrumentation?: {
    readonly metadata?: ChannelInstrumentationMetadataProjector;
  };
} & ChannelEventHandlers<TCtx>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Produces the default {@link StepInput} when no custom adapter `deliver`
 * hook is defined.
 *
 * Passes through both `message` and `inputResponses` from the delivery
 * payload so tool-approval responses (and other HITL replies) reach the
 * harness even when the channel has no bespoke deliver logic.
 */
export function defaultDeliverResult(payload: DeliverPayload): StepInput | undefined {
  if (payload.message !== undefined) {
    return {
      inputResponses: payload.inputResponses,
      message: payload.message,
      context: payload.context,
      outputSchema: payload.outputSchema,
    };
  }

  if (payload.inputResponses !== undefined && payload.inputResponses.length > 0) {
    return {
      inputResponses: payload.inputResponses,
      context: payload.context,
      outputSchema: payload.outputSchema,
    };
  }

  if (payload.context !== undefined && payload.context.length > 0) {
    return { context: payload.context, outputSchema: payload.outputSchema };
  }

  if (payload.outputSchema !== undefined) {
    return { outputSchema: payload.outputSchema };
  }

  return undefined;
}

/**
 * Returns the durable kind for an adapter.
 */
export function getAdapterKind(adapter: ChannelAdapter): string {
  return adapter.kind;
}

/**
 * Calls an adapter's event handler for a given event. Adapters perform side
 * effects rather than transforming events; after the handler runs, the
 * runtime refreshes `session.waiting` with the live continuation token so a
 * handler that re-keyed the session publishes the new resume handle.
 *
 * Throwing handlers are logged and swallowed so a downstream delivery
 * failure does not corrupt the event stream write path.
 */
export async function callAdapterEventHandler(
  adapter: ChannelAdapter,
  event: HandleMessageStreamEvent,
  ctx: ChannelAdapterContext,
): Promise<HandleMessageStreamEvent> {
  const handler = adapter[event.type] as
    | ((data: unknown, ctx: ChannelAdapterContext) => void | Promise<void>)
    | undefined;

  if (handler !== undefined) {
    try {
      await handler("data" in event ? event.data : undefined, ctx);
    } catch (error) {
      log.error("adapter event handler threw — event swallowed", {
        adapterKind: getAdapterKind(adapter),
        eventType: event.type,
        error,
      });
    }
  }

  if (event.type === "session.waiting") {
    return {
      ...event,
      data: {
        ...event.data,
        continuationToken: toChannelLocalContinuationToken(ctx.session.continuationToken),
      },
    };
  }

  return event;
}
