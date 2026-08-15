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
 * The structured fields the harness attaches to failure-event details:
 * the semantic-error catalog's identity and remediation, plus the raw
 * inspection dump for unrecognized failures. One projection so every
 * consumer narrows the untyped `details` payload the same way.
 */
export interface FailureDetails {
  readonly semanticErrorId?: string;
  readonly hint?: string;
  readonly detail?: string;
}

export function failureDetails(event: FailureStreamEvent): FailureDetails {
  const details: unknown = event.data.details;
  if (details === null || typeof details !== "object") return {};
  const record = details as { semanticErrorId?: unknown; hint?: unknown; detail?: unknown };
  const out: { -readonly [Key in keyof FailureDetails]: FailureDetails[Key] } = {};
  if (typeof record.semanticErrorId === "string") out.semanticErrorId = record.semanticErrorId;
  if (typeof record.hint === "string" && record.hint.trim().length > 0) {
    out.hint = record.hint.trim();
  }
  if (typeof record.detail === "string") out.detail = record.detail;
  return out;
}

/**
 * Extracts the structured remediation hint attached to a failure event's
 * details by the semantic-error catalog, if any.
 */
export function formatFailureHint(event: FailureStreamEvent): string | undefined {
  return failureDetails(event).hint;
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
  const detail = failureDetails(event).detail;
  if (detail === undefined) return undefined;
  const trimmed = detail.trim();
  if (trimmed.length === 0 || trimmed === event.data.message.trim()) return undefined;
  return trimmed;
}

/**
 * Local-TUI hints keyed by the semantic-error catalog id the harness
 * writes into failure details. When the failing setup can be fixed from
 * inside the session, the catalog's hint — which names CLI commands and
 * dashboard URLs — is replaced with the in-session fix.
 */
const LOCAL_HINT_OVERRIDES: Readonly<Record<string, string>> = {
  "gateway-auth-invalid-api-key":
    "Run /model to refresh credentials, or update AI_GATEWAY_API_KEY in .env.local (a stale shell export can shadow it).",
  "gateway-auth-invalid-oidc-token":
    "Run /model to refresh the OIDC token, or set AI_GATEWAY_API_KEY in .env.local.",
  "gateway-auth-missing-credentials":
    "Run /model to connect this to a project and refresh AI Gateway credentials, or set AI_GATEWAY_API_KEY manually in .env.local.",
};

/**
 * The surface-local hint for a failure, when the TUI can offer a better
 * fix than the catalog's (currently: gateway credential failures resolve
 * in-session via `/model`). Returns `undefined` to keep the harness hint.
 */
export function localFailureHint(event: FailureStreamEvent): string | undefined {
  const id = failureDetails(event).semanticErrorId;
  return id === undefined ? undefined : LOCAL_HINT_OVERRIDES[id];
}
