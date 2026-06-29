import { type AuthorizationSignal, isAuthorizationSignal } from "#harness/authorization.js";

const SANDBOX_AUTHORIZATION_INTERRUPT_NAME = "SandboxAuthorizationInterrupt";

/**
 * Internal control-flow error that carries an authorization signal from lazy
 * sandbox attachment back to the harness tool boundary.
 */
export class SandboxAuthorizationInterrupt extends Error {
  readonly signal: AuthorizationSignal;

  constructor(signal: AuthorizationSignal) {
    super("Sandbox credential authorization is required.");
    this.name = SANDBOX_AUTHORIZATION_INTERRUPT_NAME;
    this.signal = signal;
  }
}

/**
 * Cross-bundle-safe guard for {@link SandboxAuthorizationInterrupt}.
 */
export function isSandboxAuthorizationInterrupt(
  error: unknown,
): error is SandboxAuthorizationInterrupt {
  return (
    error instanceof Error &&
    error.name === SANDBOX_AUTHORIZATION_INTERRUPT_NAME &&
    isAuthorizationSignal((error as { readonly signal?: unknown }).signal)
  );
}
