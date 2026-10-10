/** Error display shared by the TUI runner and renderer. */
import { failureOf } from "#client/session-utils.js";
import type { SessionStreamEvent } from "#protocol/session-event.js";

/** A terminal fact that can report a failure; model retries aren't user-visible failures. */
export type FailureStreamEvent = Extract<
  SessionStreamEvent,
  { type: "turn.settled" | "session.ended" }
>;

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

/** A terminal session can repeat its turn's error; show the underlying failure once. */
export function failureKey(event: FailureStreamEvent): string {
  const error = failureOf(event);
  return `${error?.id ?? ""}:${error?.code ?? ""}:${error?.message ?? ""}`;
}

export function formatFailureMessage(event: FailureStreamEvent): string {
  const error = failureOf(event);
  if (error === undefined) return "";
  const { code, message } = error;
  if (message === code || message.startsWith(`${code}:`) || message.startsWith(`${code} `))
    return message;
  return `${code}: ${message}`;
}

export function formatFailureHint(event: FailureStreamEvent): string | undefined {
  return failureOf(event)?.hint;
}

/** v27 exposes a support id, not the private diagnostic dump. */
export function formatFailureDetail(event: FailureStreamEvent): string | undefined {
  const id = failureOf(event)?.id;
  return id === undefined ? undefined : `Error ID: ${id}`;
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

export function localFailureHint(event: FailureStreamEvent): string | undefined {
  const error = failureOf(event);
  return error === undefined ? undefined : LOCAL_HINT_OVERRIDES[error.code];
}
