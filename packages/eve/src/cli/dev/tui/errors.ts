/**
 * Error classification and display formatting shared by the TUI runner and
 * terminal renderer. One module owns the interrupt sentinel and the
 * failure-event projections so the two sides cannot drift apart.
 */

import type {
  SessionFailedStreamEvent,
  StepFailedStreamEvent,
  TurnFailedStreamEvent,
} from "#client/index.js";
import {
  GATEWAY_AUTH_FAILURE_SUMMARY_NAME,
  GATEWAY_AUTHENTICATION_ERROR_NAME,
} from "#harness/model-call-error.js";

/**
 * One of the failure events a session stream can carry. All three share the
 * same `{ code, message, details? }` payload shape — the harness emits them
 * as a cascade (`step.failed` → `turn.failed` → `session.failed` /
 * `session.waiting`) describing a single underlying failure.
 */
export type FailureStreamEvent =
  | StepFailedStreamEvent
  | TurnFailedStreamEvent
  | SessionFailedStreamEvent;

/**
 * Thrown when the user interrupts the TUI (Ctrl+C, or Ctrl+D on an empty
 * prompt). The runner treats it as a clean exit, never as a failure.
 */
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

/**
 * Recognizes errors raised by aborting an in-flight fetch/stream (e.g. the
 * subagent child-session pump being cancelled). These are expected shutdown
 * noise, not failures to surface.
 */
export function isAbortLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || /\babort(?:ed)?\b/iu.test(error.message);
}

/**
 * Stable identity for one failure cascade entry. The harness emits the same
 * `{ code, message }` payload on `step.failed`, `turn.failed`, and (for
 * terminal failures) `session.failed`; keying on both lets the stream
 * translator render the underlying failure exactly once.
 */
export function failureKey(event: FailureStreamEvent): string {
  return `${event.data.code}:${event.data.message}`;
}

/**
 * One-line headline for a failure event: `code: message`, except when the
 * message already carries its own class-name prefix (e.g. a
 * `HookConflictError` whose message starts with `HookConflictError:`), in
 * which case the message stands alone instead of reading `Code: Code: …`.
 */
export function formatFailureMessage(event: FailureStreamEvent): string {
  const { code, message } = event.data;
  if (!code) return message;
  if (message === code || message.startsWith(`${code}:`) || message.startsWith(`${code} `)) {
    return message;
  }
  return `${code}: ${message}`;
}

/**
 * Extracts the diagnostic dump attached to a failure event, if any.
 *
 * `details.detail` is the `util.inspect` rendering (stack trace and cause
 * chain included) that `formatError` attaches to *unrecognized* failures —
 * i.e. code bugs escaping user code. Recognized provider/config failures
 * deliberately ship a curated summary without the dump, so this returns
 * `undefined` for them and the headline stands alone.
 */
export function formatFailureDetail(event: FailureStreamEvent): string | undefined {
  const details: unknown = event.data.details;
  if (details === null || typeof details !== "object") return undefined;
  const detail = (details as { detail?: unknown }).detail;
  if (typeof detail !== "string") return undefined;
  const trimmed = detail.trim();
  if (trimmed.length === 0 || trimmed === event.data.message.trim()) return undefined;
  return trimmed;
}

/**
 * Minimal TUI rendering for a gateway-auth failure when `/model` is available
 * locally. Replaces the harness's full summary — whose remediation names CLI
 * commands and dashboard URLs — with one actionable line; the caller drops
 * the diagnostic detail along with it. The variant is picked off the summary
 * message the harness wrote, so a stale key, an expired OIDC token, and
 * missing credentials each get the fix that actually applies.
 */
export function formatGatewayAuthFailureNotice(event: FailureStreamEvent): string {
  const message = event.data.message;
  if (/rejected the provided API key|Invalid API key/i.test(message)) {
    return "AI Gateway rejected your AI_GATEWAY_API_KEY. Run /model to refresh credentials, or update it in .env.local (a stale shell export can shadow it).";
  }
  if (/rejected the OIDC token|Invalid OIDC token/i.test(message)) {
    return "Your AI Gateway OIDC token is invalid or expired. Run /model to refresh it, or set AI_GATEWAY_API_KEY in .env.local.";
  }
  return "There is no AI_GATEWAY_API_KEY set. Run /model to connect this to a project and refresh AI Gateway credentials, or set it manually in .env.local.";
}

/**
 * Recognizes a model-call failure caused by AI Gateway authentication. The
 * primary signal is the machine-readable `gatewayName` the harness merges
 * into every model-call failure's details (`extractModelCallErrorDetails`);
 * the summary name is the fallback for payloads whose gateway error was not
 * preserved on the cause chain. Both identifiers are imported from the
 * harness module that writes them, so the two sides cannot drift.
 */
export function isGatewayAuthFailure(event: FailureStreamEvent): boolean {
  const details: unknown = event.data.details;
  if (details === null || typeof details !== "object") return false;
  const record = details as { gatewayName?: unknown; name?: unknown };
  return (
    record.gatewayName === GATEWAY_AUTHENTICATION_ERROR_NAME ||
    record.name === GATEWAY_AUTH_FAILURE_SUMMARY_NAME
  );
}
