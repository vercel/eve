/**
 * Stable framework-owned route prefix reserved for eve's runtime transport
 * surfaces.
 */
export const EVE_ROUTE_PREFIX = "/eve/v1";

/**
 * Stable framework-owned health route.
 */
export const EVE_HEALTH_ROUTE_PATH = `${EVE_ROUTE_PREFIX}/health`;

/**
 * Stable framework-owned route exposing the JSON inspection payload for
 * the current agent. The eve channel registers and authenticates this route
 * with the same `auth` input as its session routes.
 */
export const EVE_INFO_ROUTE_PATH = `${EVE_ROUTE_PREFIX}/info`;

/**
 * Stable framework-owned route for creating a new session.
 */
export const EVE_CREATE_SESSION_ROUTE_PATH = `${EVE_ROUTE_PREFIX}/session`;

/**
 * Stable framework-owned route pattern for sending a message to an existing
 * session.
 */
export const EVE_CONTINUE_SESSION_ROUTE_PATTERN = `${EVE_ROUTE_PREFIX}/session/:sessionId`;

/**
 * Stable framework-owned message stream route pattern.
 */
export const EVE_MESSAGE_STREAM_ROUTE_PATTERN = `${EVE_ROUTE_PREFIX}/session/:sessionId/stream`;

/**
 * Stable framework-owned route pattern for cancelling a session's
 * in-flight turn. Accepts an optional `{ turnId }` body guard scoping
 * the cancel to the turn the caller observed.
 */
export const EVE_CANCEL_TURN_ROUTE_PATTERN = `${EVE_ROUTE_PREFIX}/session/:sessionId/cancel`;

/**
 * Framework-owned route pattern for dispatching one authored schedule
 * exactly once from the dev server.
 *
 * Only registered when Nitro is running in dev mode — production builds
 * never mount this route. Smoke tests and human developers use it to
 * trigger a schedule out-of-band (without a cron firing) and recover the
 * resulting `{ scheduleId, sessionIds }` payload as JSON so they can
 * subscribe to {@link EVE_MESSAGE_STREAM_ROUTE_PATTERN} for each session.
 *
 * `:scheduleId` is the authored schedule's filesystem-derived name (e.g.
 * `agent/schedules/heartbeat.ts` -> `"heartbeat"`).
 */
export const EVE_DEV_DISPATCH_SCHEDULE_ROUTE_PATTERN = `${EVE_ROUTE_PREFIX}/dev/schedules/:scheduleId`;

/**
 * Dev-only route exposing the current runtime artifact revision.
 *
 * Local development clients use this to decide when an HMR rebuild has
 * published new runtime artifacts, so their next normal prompt can start a
 * fresh server-side session while in-flight sessions keep their original
 * snapshot.
 */
export const EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH = `${EVE_ROUTE_PREFIX}/dev/runtime-artifacts`;

/**
 * Dev-only route that flushes queued runtime artifact rebuilds before
 * returning the current revision.
 */
export const EVE_DEV_RUNTIME_ARTIFACTS_REBUILD_ROUTE_PATH = `${EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH}/rebuild`;

/**
 * Builds the dev-only schedule dispatch URL for one named authored
 * schedule. The path encodes the schedule id so reserved characters in
 * authored filenames round-trip safely.
 */
export function createEveDevDispatchSchedulePath(scheduleId: string): string {
  return `${EVE_ROUTE_PREFIX}/dev/schedules/${encodeURIComponent(scheduleId)}`;
}

/**
 * Stable framework-owned route pattern for receiving inbound IdP redirects
 * during in-turn interactive connection authorization.
 *
 * `:name` is the connection name; `:token` is the workflow hook token minted
 * by the workflow body so the route handler can resume the suspended turn
 * via `resumeHook(token, payload)`.
 *
 * The route is unauthenticated by design: an OAuth IdP follows this URL
 * via a 3xx redirect from the user's browser with no eve credentials
 * attached. The token is the unguessable capability that authorizes the
 * resume; anyone who has it can deliver the callback payload, which is
 * exactly what the IdP needs to do.
 */
export const EVE_CONNECTION_CALLBACK_ROUTE_PATTERN = `${EVE_ROUTE_PREFIX}/connections/:name/callback/:token`;

/**
 * Stable framework-owned route pattern for terminal session callbacks.
 *
 * The `:token` segment is an unguessable workflow hook capability. The route
 * is unauthenticated by design and resumes the matching parked runtime action.
 */
export const EVE_CALLBACK_ROUTE_PATTERN = `${EVE_ROUTE_PREFIX}/callback/:token`;

/**
 * Creates the stable framework-owned message stream route path for one session.
 */
export function createEveMessageStreamRoutePath(sessionId: string): string {
  return `${EVE_ROUTE_PREFIX}/session/${encodeURIComponent(sessionId)}/stream`;
}

/**
 * Creates the stable framework-owned continue-session route path.
 */
export function createEveContinueSessionRoutePath(sessionId: string): string {
  return `${EVE_ROUTE_PREFIX}/session/${encodeURIComponent(sessionId)}`;
}

/**
 * Creates the stable framework-owned cancel-turn route path for one session.
 */
export function createEveCancelTurnRoutePath(sessionId: string): string {
  return `${EVE_ROUTE_PREFIX}/session/${encodeURIComponent(sessionId)}/cancel`;
}

/**
 * Creates the stable framework-owned connection callback route path for
 * one (`name`, `token`) pair.
 *
 * The workflow body builds this path against {@link EVE_ROUTE_PREFIX} when
 * minting the redirect URL it hands to the IdP via `startAuthorization`.
 * The runtime's framework callback route handler matches the same path
 * pattern and forwards the projected request payload into
 * `resumeHook(token, payload)`.
 */
export function createEveConnectionCallbackRoutePath(name: string, token: string): string {
  return `${EVE_ROUTE_PREFIX}/connections/${encodeURIComponent(name)}/callback/${encodeURIComponent(token)}`;
}

/**
 * Creates the stable framework-owned terminal callback route path.
 */
export function createEveCallbackRoutePath(token: string): string {
  return `${EVE_ROUTE_PREFIX}/callback/${encodeURIComponent(token)}`;
}
