/**
 * Canonical turn-cancellation error and abort-signal helpers.
 *
 * The harness detects cancellation from the turn's `AbortSignal` — never
 * from thrown error shapes — and always rethrows one canonical error so
 * every layer above (retry, recovery, failure classification, workflow
 * settlement) can tell an intentional cancellation apart from a failure.
 */

const TURN_CANCELLED_ERROR_NAME = "TurnCancelledError";

/**
 * Terminal outcome of a cancelled turn.
 *
 * Plain and cause-free so it round-trips workflow step serialization, and
 * matched by `name` rather than `instanceof` so the check survives
 * structured-clone coercion and duplicated package instances.
 */
export class TurnCancelledError extends Error {
  constructor(message = "The turn was cancelled.") {
    super(message);
    this.name = TURN_CANCELLED_ERROR_NAME;
  }
}

/**
 * True when the error (or any error in its cause chain) is the canonical
 * {@link TurnCancelledError}. Generic abort shapes (`AbortError`
 * `DOMException`s, timeouts) intentionally do not match: a tool's internal
 * fetch timeout is a failure, not a turn cancellation.
 */
export function isTurnCancellation(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();

  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    if ((current as { name?: unknown }).name === TURN_CANCELLED_ERROR_NAME) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }

  return false;
}

/**
 * Throws the canonical cancellation error when the turn signal has
 * aborted; no-op otherwise. An abort reason that already is a turn
 * cancellation is rethrown as-is so one turn observes one error instance.
 */
export function throwIfTurnAborted(abortSignal: AbortSignal | undefined): void {
  if (abortSignal?.aborted !== true) {
    return;
  }
  if (isTurnCancellation(abortSignal.reason)) {
    throw abortSignal.reason;
  }
  throw new TurnCancelledError();
}
