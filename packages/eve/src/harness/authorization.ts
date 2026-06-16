/**
 * Authorization request/result API for tool execution.
 *
 * Public API:
 * - {@link requestAuthorization} — return from execute to suspend for auth
 * - {@link getAuthorizationResult} — read the callback on resume
 * - {@link getHookUrl} — build a callback URL for external systems
 * - {@link isAuthorizationSignal} — type guard
 *
 * ## Resume lifecycle
 *
 * `resume` is how an interactive strategy carries data from
 * `startAuthorization` to `completeAuthorization` across the park:
 *
 * 1. `startAuthorization` returns `{ challenge, resume? }`. The runtime
 *    stores `resume` on the {@link AuthorizationChallenge} and journals it
 *    onto `session.state` via {@link setPendingAuthorization} when the turn
 *    parks — so it survives the suspend/resume across a `"use step"`
 *    boundary.
 * 2. The IdP redirect hits the framework callback route, which parses it
 *    (see `projectAuthorizationCallback` — params only, no headers) and
 *    resumes the workflow.
 * 3. On resume the journaled `resume` is paired with the parsed callback
 *    into an {@link AuthorizationResult} and handed back to
 *    `completeAuthorization({ resume, callback })`.
 *
 * `resume` is serialized across workflow steps to survive the park.
 * Provider-owned strategies (Vercel Connect) omit it so nothing crosses
 * the boundary; a custom PKCE strategy uses it to carry the verifier (or a
 * nonce that re-derives it) from start to finish.
 */

import { loadContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import { SessionIdKey } from "#context/keys.js";
import type { ConnectionAuthorizationChallenge } from "#public/connections/errors.js";
import type { AuthorizationCallback } from "#runtime/connections/types.js";
import type { JsonValue } from "#public/types/json.js";
import { createEveConnectionCallbackRoutePath } from "#protocol/routes.js";

const AUTHORIZATION_BRAND = "__eveAuthorization" as const;
const AUTHORIZATION_PENDING_BRAND = "__eveAuthorizationPending" as const;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AuthorizationChallenge {
  readonly name: string;
  readonly challenge: ConnectionAuthorizationChallenge;
  readonly hookUrl: string;
  /**
   * Opaque resume value from the strategy's `startAuthorization`,
   * journaled across the park. Absent for provider-owned flows.
   */
  readonly resume?: JsonValue;
}

export interface AuthorizationSignal {
  readonly [AUTHORIZATION_BRAND]: true;
  readonly challenges: readonly AuthorizationChallenge[];
}

/**
 * Opaque tool output the model sees while authorization is pending.
 * Contains connection names only — no OAuth URLs, user codes, or hook URLs.
 */
export interface AuthorizationPendingModelOutput {
  readonly [AUTHORIZATION_PENDING_BRAND]: true;
  readonly connections: readonly string[];
}

export interface AuthorizationResult {
  readonly resume?: JsonValue;
  readonly callback: AuthorizationCallback;
  readonly hookUrl: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Creates an authorization signal. Return this from a tool's execute
 * to suspend the session for OAuth or other external authorization.
 *
 * The harness emits `authorization.required` events for each challenge
 * and parks the session. Channels render sign-in buttons.
 */
export function requestAuthorization(
  challenges: readonly AuthorizationChallenge[],
): AuthorizationSignal {
  return { [AUTHORIZATION_BRAND]: true, challenges };
}

/**
 * Returns a copy of `signal` with each challenge's `resume` value stripped.
 *
 * Used for the copy the AI SDK records as a tool output. The shape stays a
 * valid {@link AuthorizationSignal} so every `isAuthorizationSignal` consumer
 * still detects it; the park detector reads the full challenges from the
 * harness's out-of-band stash.
 */
export function redactSignalResume(signal: AuthorizationSignal): AuthorizationSignal {
  return requestAuthorization(
    signal.challenges.map((entry) => ({
      name: entry.name,
      challenge: entry.challenge,
      hookUrl: entry.hookUrl,
    })),
  );
}

/**
 * Reads the authorization callback on resume. Returns `undefined` if
 * not resuming from an authorization request.
 *
 * When `name` is omitted, returns the first result (convenience for
 * single-challenge tools).
 */
export function getAuthorizationResult(name?: string): AuthorizationResult | undefined {
  const results = loadContext().get(PendingAuthorizationResultKey);
  if (!results || results.length === 0) return undefined;
  if (name === undefined) return results[0];
  return results.find((r) => r.name === name);
}

/**
 * Builds a callback URL for external systems. `name` identifies the
 * callback in the URL path (e.g. a connection name or custom label).
 *
 * The URL embeds a per-authorization hook token derived from the
 * session ID and name (`${sessionId}:auth:${name}`). This token is
 * independent of the continuation token, so channel re-keying
 * mid-turn does not invalidate the callback URL.
 *
 * Returns `undefined` if the session context isn't available.
 */
export function getHookUrl(name: string): string | undefined {
  const ctx = loadContext();
  const sessionId = ctx.get(SessionIdKey);
  const baseUrl = ctx.get(CallbackBaseUrlKey);
  if (!sessionId || !baseUrl) return undefined;
  const token = authHookToken(sessionId);
  return `${baseUrl}${createEveConnectionCallbackRoutePath(name, token)}`;
}

export function isAuthorizationSignal(value: unknown): value is AuthorizationSignal {
  if (typeof value !== "object" || value === null) return false;
  return (value as Record<string, unknown>)[AUTHORIZATION_BRAND] === true;
}

export function isAuthorizationPendingModelOutput(
  value: unknown,
): value is AuthorizationPendingModelOutput {
  if (typeof value !== "object" || value === null) return false;
  return (value as Record<string, unknown>)[AUTHORIZATION_PENDING_BRAND] === true;
}

/**
 * JSON-safe pending authorization output for model-facing tool results and
 * wire surfaces (`action.result`, telemetry). Omits OAuth URLs and user
 * codes — connection names only.
 */
export function authorizationPendingAsJsonObject(input: {
  readonly connections: readonly string[];
}): AuthorizationPendingModelOutput {
  return {
    [AUTHORIZATION_PENDING_BRAND]: true,
    connections: [...input.connections],
  };
}

/**
 * Projects a full {@link AuthorizationSignal} to the opaque shape recorded
 * in model-facing tool results and session history.
 */
export function modelFacingAuthorizationOutput(
  signal: AuthorizationSignal,
): AuthorizationPendingModelOutput {
  return authorizationPendingAsJsonObject({
    connections: signal.challenges.map((entry) => entry.name),
  });
}

/** Human-readable tool output for {@link modelFacingAuthorizationOutput}. */
export function authorizationPendingModelText(connections: readonly string[]): string {
  if (connections.length === 0) {
    return "Authorization required. Waiting for the user to sign in.";
  }
  if (connections.length === 1) {
    return `Authorization required for ${connections[0]}. Waiting for the user to sign in.`;
  }
  return `Authorization required for ${connections.join(", ")}. Waiting for the user to sign in.`;
}

export function isPendingAuthorizationToolOutput(value: unknown): boolean {
  return isAuthorizationPendingModelOutput(value) || isAuthorizationSignal(value);
}

/**
 * Deterministic hook token for all authorization callbacks in a
 * session. Both {@link getHookUrl} (inside tool execution) and the
 * workflow body (which creates the hook upfront) use this token.
 */
export function authHookToken(sessionId: string): string {
  return `${sessionId}:auth`;
}

// ---------------------------------------------------------------------------
// Context keys
// ---------------------------------------------------------------------------

interface NamedAuthorizationResult extends AuthorizationResult {
  readonly name: string;
}

export const PendingAuthorizationResultKey = new ContextKey<readonly NamedAuthorizationResult[]>(
  "eve.pendingAuthorizationResult",
);

/**
 * Deployment base URL for building callback URLs. Set by the
 * framework (turnStep) at the start of each step from workflow
 * metadata.
 */
export const CallbackBaseUrlKey = new ContextKey<string>("eve.callbackBaseUrl");

// ---------------------------------------------------------------------------
// Session state persistence (internal — used by framework only)
// ---------------------------------------------------------------------------

const PENDING_AUTHORIZATION_KEY = "eve.runtime.pendingAuthorization";

export interface PendingAuthorizationState {
  readonly challenges: readonly AuthorizationChallenge[];
}

export function setPendingAuthorization(
  sessionState: Record<string, unknown> | undefined,
  value: PendingAuthorizationState,
): Record<string, unknown> {
  return { ...sessionState, [PENDING_AUTHORIZATION_KEY]: value };
}

export function getPendingAuthorization(
  sessionState: Record<string, unknown> | undefined,
): PendingAuthorizationState | undefined {
  if (!sessionState) return undefined;
  const v = sessionState[PENDING_AUTHORIZATION_KEY];
  if (typeof v !== "object" || v === null) return undefined;
  return v as PendingAuthorizationState;
}

export function hasPendingAuthorization(
  sessionState: Record<string, unknown> | undefined,
): boolean {
  return getPendingAuthorization(sessionState) !== undefined;
}
