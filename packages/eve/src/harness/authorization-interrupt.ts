import { type AuthorizationSignal, isAuthorizationSignal } from "#harness/authorization.js";

const AUTHORIZATION_INTERRUPT_NAME = "EveAuthorizationInterrupt";

/**
 * Internal control-flow error that carries an authorization signal from deep
 * inside a tool execution (e.g. lazy sandbox attachment) back to the harness
 * tool boundary, where it surfaces as the standard authorization-pending
 * tool output.
 */
export class AuthorizationInterrupt extends Error {
  readonly signal: AuthorizationSignal;

  constructor(signal: AuthorizationSignal) {
    super("Credential authorization is required.");
    this.name = AUTHORIZATION_INTERRUPT_NAME;
    this.signal = signal;
  }
}

/**
 * Cross-bundle-safe guard for {@link AuthorizationInterrupt}.
 */
export function isAuthorizationInterrupt(error: unknown): error is AuthorizationInterrupt {
  return (
    error instanceof Error &&
    error.name === AUTHORIZATION_INTERRUPT_NAME &&
    isAuthorizationSignal((error as { readonly signal?: unknown }).signal)
  );
}
