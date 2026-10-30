/** Error display shared by the TUI runner and renderer. */
import type { ErrorInfo } from "#protocol/session-events/envelope.js";

/** A user interrupt is a clean exit, never a failure. */
export class InterruptedError extends Error {
  constructor() {
    super("Interrupted");
    this.name = "InterruptedError";
  }
}

export function interruptedError(): InterruptedError {
  return new InterruptedError();
}

export function isInterruptedError(error: unknown): boolean {
  return error instanceof InterruptedError;
}

/** Two failures with one key are the same failure, as a session repeating its turn's. */
export function failureKey(error: ErrorInfo): string {
  return `${error.id ?? ""}:${error.code}:${error.message}`;
}

export function formatFailureMessage({ code, message }: ErrorInfo): string {
  if (message === code || message.startsWith(`${code}:`) || message.startsWith(`${code} `))
    return message;
  return `${code}: ${message}`;
}

/** v27 exposes a support id, not the private diagnostic dump. */
export function formatFailureDetail(error: ErrorInfo): string | undefined {
  return error.id === undefined ? undefined : `Error ID: ${error.id}`;
}

/** Surface-local remediation when the failure code names a supported gateway setup problem. */
const LOCAL_HINT_OVERRIDES: Readonly<Record<string, string>> = {
  "gateway-auth-invalid-api-key":
    "Run /model to refresh credentials, or update AI_GATEWAY_API_KEY in .env.local (a stale shell export can shadow it).",
  "gateway-auth-invalid-oidc-token":
    "Run /model to refresh the OIDC token, or set AI_GATEWAY_API_KEY in .env.local.",
  "gateway-auth-missing-credentials":
    "Run /model to connect this to a project and refresh AI Gateway credentials, or set AI_GATEWAY_API_KEY manually in .env.local.",
};

export function localFailureHint(error: ErrorInfo): string | undefined {
  return LOCAL_HINT_OVERRIDES[error.code];
}
