/**
 * Typed error classes for the connection authorization lifecycle.
 */

/**
 * User-facing authorization challenge payload.
 */
export interface ConnectionAuthorizationChallenge {
  /**
   * Optional URL the user should visit to complete authorization.
   * Serves as the redirect target, the verification URL in device
   * code flow, or the source for a QR code.
   */
  readonly url?: string;

  /**
   * Optional short code to display alongside `url` (device code flow).
   */
  readonly userCode?: string;

  /**
   * Optional ISO timestamp at which the authorization opportunity
   * expires. When provided, the runtime clamps the authorization deadline to
   * `min(configured_timeout, expiresAt)` so the turn cannot outlive
   * the challenge.
   */
  readonly expiresAt?: string;

  /**
   * Optional human-readable call to action. When no `url` is
   * available (e.g. CIBA, push-to-approve), this is what the channel
   * should show as the primary affordance.
   */
  readonly instructions?: string;

  /**
   * Optional human-readable provider name for sign-in UI (e.g.
   * `"Salesforce"`). Presentation-only: identity (the authorization
   * scope, token cache keys, callback URLs) stays the path-derived
   * name. Channels fall back to title-casing the scope name when
   * absent.
   */
  readonly displayName?: string;
}

/**
 * Options accepted by {@link ConnectionAuthorizationRequiredError}.
 */
export interface ConnectionAuthorizationRequiredErrorOptions {
  /**
   * Override for the default `Error.message`. Defaults to
   * `Connection "{name}" requires authorization.` when omitted.
   */
  readonly message?: string;
}

/**
 * Options accepted by {@link ConnectionAuthorizationFailedError}.
 */
export interface ConnectionAuthorizationFailedErrorOptions {
  /**
   * Override for the default `Error.message`. Defaults to
   * `Connection "{name}" authorization failed.` when omitted.
   */
  readonly message?: string;

  /**
   * Stable machine-readable code describing why authorization failed.
   *
   * The runtime surfaces this code on the `authorization.completed`
   * stream event and on the failed tool result the model sees. Use a
   * short kebab- or snake-cased string (e.g. `"access_denied"`,
   * `"invalid_grant"`).
   *
   * The runtime also emits a few reason codes itself, independently
   * of authored throws:
   *
   * - `"principal_required"`: a `principalType: "user"` connection
   *   was invoked without an authenticated user principal. Terminal.
   * - `"app_not_installed"`: an authored `getToken` for a
   *   `principalType: "app"` connection signalled the agent's own
   *   credentials are missing. Terminal.
   */
  readonly reason?: string;

  /**
   * Controls whether the runtime re-prompts the user after this
   * failure.
   *
   * Defaults to `true`; set `false` for terminal cases such as user
   * denial (`reason: "access_denied"`).
   */
  readonly retryable?: boolean;
}

/**
 * Thrown from a connection's `getToken` when no valid credential is
 * available and authorization must be completed before the connection
 * can be used. Covers both interactive OAuth (the runtime emits
 * `authorization.required` and suspends the turn on a webhook) and
 * non-interactive / out-of-band flows such as static API keys (the
 * runtime emits `authorization.required` without suspending).
 */
export class ConnectionAuthorizationRequiredError extends Error {
  readonly connectionName: string;

  constructor(connectionName: string, options?: ConnectionAuthorizationRequiredErrorOptions) {
    super(options?.message ?? `Connection "${connectionName}" requires authorization.`);
    this.name = "ConnectionAuthorizationRequiredError";
    this.connectionName = connectionName;
  }
}

/**
 * Thrown when a connection's authorization fails.
 *
 * Retryable by default; pass `retryable: false` for terminal failures
 * where starting a fresh authorization flow would be wrong.
 */
export class ConnectionAuthorizationFailedError extends Error {
  readonly connectionName: string;
  readonly reason?: string;
  readonly retryable: boolean;

  constructor(connectionName: string, options?: ConnectionAuthorizationFailedErrorOptions) {
    super(options?.message ?? `Connection "${connectionName}" authorization failed.`);
    this.name = "ConnectionAuthorizationFailedError";
    this.connectionName = connectionName;
    this.reason = options?.reason;
    this.retryable = options?.retryable ?? true;
  }
}

/**
 * Type guard for {@link ConnectionAuthorizationRequiredError}.
 *
 * Uses `err.name` rather than `instanceof` because user code and
 * framework internals can end up with different class identities
 * after bundling (dual-instance hazard in Nitro output).
 */
export function isConnectionAuthorizationRequiredError(
  err: unknown,
): err is ConnectionAuthorizationRequiredError {
  return err instanceof Error && err.name === "ConnectionAuthorizationRequiredError";
}

/**
 * Type guard for {@link ConnectionAuthorizationFailedError}.
 *
 * Uses `err.name` rather than `instanceof` because user code and
 * framework internals can end up with different class identities
 * after bundling (dual-instance hazard in Nitro output).
 */
export function isConnectionAuthorizationFailedError(
  err: unknown,
): err is ConnectionAuthorizationFailedError {
  return err instanceof Error && err.name === "ConnectionAuthorizationFailedError";
}
