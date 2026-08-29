import type { UserContent } from "ai";

import type { SessionAuthContext, TurnPolicy } from "#channel/types.js";
import type { TrustedForwarders } from "#channel/forwarded-principal.js";
import type { AuthFn } from "#public/channels/auth.js";
import type { UploadPolicyInput } from "#public/channels/upload-policy.js";
import type {
  Channel,
  ChannelContinuationOps,
  ChannelEvents,
  ChannelMethod,
} from "#public/definitions/channel.js";

/**
 * Event-handler channel context exposed by `eveChannel({ events })`. The default eve HTTP channel
 * has no platform-specific state, so handlers receive optional continuation routing here and the
 * `SessionContext` third argument from {@link ChannelEvents}.
 */
export type EveEventContext = ChannelContinuationOps;

/** Runtime stream-event handlers supported by `eveChannel({ events })`. */
export type EveChannelEvents = ChannelEvents<EveEventContext>;

export interface EveChannelCorsOptions {
  /**
   * Allowed request origin. Pass a single origin string, an exact-origin list,
   * `"null"`, or `"*"`. Omit for `"*"`.
   */
  readonly origin?: "*" | "null" | string | readonly string[];
  /** Methods emitted on preflight responses. Omit for `"*"`. */
  readonly methods?: "*" | readonly ChannelMethod[];
  /** Request headers emitted on preflight responses. Omit for `"*"`. */
  readonly allowedHeaders?: "*" | readonly string[];
  /** Response headers exposed to browser callers. Omit for `"*"`. */
  readonly exposedHeaders?: "*" | readonly string[];
  /** Whether to emit `access-control-allow-credentials: true`. */
  readonly credentials?: boolean;
  /** Max age, in seconds, emitted on preflight responses. */
  readonly maxAge?: number | false;
  /** Preflight response status code. Defaults to 204. */
  readonly preflightStatus?: number;
}

/**
 * Higher-level CORS policy for the default eve HTTP channel. Pass `true` for
 * fully permissive browser access, or pass an options object to narrow it.
 */
export type EveChannelCors = boolean | EveChannelCorsOptions;

/** Low-level eve HTTP handle exposed to `eveChannel({ onMessage })`. */
export interface EveHandle {
  /** Route-auth result for the request; `onMessage` chooses session auth by returning `{ auth }`. */
  readonly caller: SessionAuthContext | null;
  readonly request: Request;
  /** Existing runtime session id for follow-up requests. */
  readonly sessionId?: string;
}

/** Pre-dispatch context passed to `eveChannel({ onMessage })`. */
export interface EveMessageContext {
  readonly eve: EveHandle;
}

/**
 * Result of `eveChannel({ onMessage })`. The object dispatches the inbound message,
 * optionally prepending `context` strings as user messages.
 */
export type EveMessageResult = {
  readonly auth: SessionAuthContext | null;
  readonly context?: readonly string[];
  /** Overrides the workflow run title without changing the message sent to the model. */
  readonly title?: string;
};

/** Synchronous or asynchronous `onMessage` result. */
export type EveMessageResultOrPromise = EveMessageResult | Promise<EveMessageResult>;

/**
 * Default `onMessage` auth projection: returns {@link EveHandle.caller} unchanged as the
 * runtime session auth when {@link EveChannelInput.onMessage} is omitted. Call it from a custom `onMessage` to inherit the default while adding `context`.
 */
export function defaultEveAuth(ctx: EveMessageContext): SessionAuthContext | null {
  return ctx.eve.caller;
}

/**
 * Configuration for {@link eveChannel}. Only {@link auth} is required;
 * `uploadPolicy`, `onMessage`, and `events` refine the default HTTP behavior.
 */
export interface EveChannelInput {
  /**
   * Route auth policy: a single {@link AuthFn} or an ordered array walked by {@link routeAuth}.
   * The first entry returning a {@link SessionAuthContext} wins; `null` / `undefined` skips to
   * the next; exhaustion (including the empty array) rejects with 401. Include `none()` last for anonymous traffic.
   */
  readonly auth: AuthFn<Request> | readonly AuthFn<Request>[];
  /**
   * The trusted-forwarders policy: which transport-authenticated callers may
   * assert a forwarded principal on the create-session or continuation route (the
   * `forwardedPrincipal` body field a `defineRemoteAgent({ forwardPrincipal:
   * true })` sender emits). The predicate receives the *verified* route-auth
   * principal of the forwarder — who is asserting, never what is asserted —
   * and must match it precisely (for example
   * `(forwarder) => forwarder.subject === vercelSubject({ teamSlug, projectName })`).
   * A permissive predicate lets any authenticated forwarder assert any
   * principal.
   *
   * When a trusted forwarder's assertion is accepted on session creation, the
   * forwarded principal replaces `session.auth.current` and
   * `session.auth.initiator`. On continuation, only `session.auth.current`
   * changes; the initiator remains pinned to the session's creator. The
   * forwarder is recorded on accepted contexts as the `eve:forwarded-by`
   * attribute. Omit the option to reject every forwarded assertion with 403.
   */
  readonly trustedForwarders?: TrustedForwarders;
  /**
   * Transport-authenticated callers whose remote trace policy may be inherited.
   * The inherited policy is accepted only on callback-bound requests with a
   * valid `traceparent` and is intersected with this deployment's trace policy.
   */
  readonly trustedTraceForwarders?: TrustedForwarders;
  /**
   * Attachment policy for inbound file parts. Omit for the framework default (25 MB cap, all media
   * types); `"disabled"` rejects every attachment; a partial config is merged onto the default. Violations reject with 413 (too large) or 415 (bad type).
   */
  readonly uploadPolicy?: UploadPolicyInput;
  /**
   * Browser CORS policy for the eve HTTP routes. Omit or pass `false` to leave
   * CORS untouched, pass `true` for fully permissive CORS, or pass an options
   * object to narrow the policy.
   */
  readonly cors?: EveChannelCors;
  /** Policy for follow-up messages that arrive while a turn is active. */
  readonly turnPolicy?: TurnPolicy;
  /**
   * Pre-dispatch hook for inbound eve HTTP messages. Runs after route auth and body
   * parsing, before runtime dispatch.
   */
  readonly onMessage?: (
    ctx: EveMessageContext,
    message: string | UserContent,
  ) => EveMessageResultOrPromise;
  /**
   * Runtime stream-event handlers for the default eve HTTP channel. Handlers receive
   * the event data, {@link EveEventContext}, and `SessionContext` (the same shape as custom channels).
   */
  readonly events?: EveChannelEvents;
}

/**
 * Concrete return type of {@link eveChannel}. Named so consumers can default-export an
 * `eveChannel(...)` call under `declaration: true` without TypeScript falling back to an
 * internal path for `Channel`.
 */
export interface EveChannel extends Channel {}
