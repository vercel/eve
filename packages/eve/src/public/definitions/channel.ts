import type { DeliverInput, GetEventStreamOptions, RunHandle, RunInput } from "#channel/types.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";

export type { GetEventStreamOptions } from "#channel/types.js";

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
   * Pass `options.startIndex` to skip events the caller has already
   * consumed — the framework HTTP session-stream route uses this to forward
   * the `startIndex` query parameter so reconnecting clients resume from
   * the next unread event instead of replaying the session from the start.
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
