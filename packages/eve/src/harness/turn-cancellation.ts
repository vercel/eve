const TURN_CANCELLED_ERROR_NAME = "TurnCancelledError";

/** Terminal outcome of a cancelled turn. */
export class TurnCancelledError extends Error {
  constructor(message = "The turn was cancelled.") {
    super(message);
    this.name = TURN_CANCELLED_ERROR_NAME;
  }
}

/**
 * A turn cancellation raised when the user declines a session-limit
 * continuation prompt. Carries intent only — the execution layer detects it
 * at the step boundary and cancels the root turn, so a delegated child's
 * decline stops the whole delegation tree. Keeps the harness free of
 * cross-session cancellation authority.
 */
export class SessionLimitDeclinedError extends TurnCancelledError {
  readonly sessionLimitDeclined = true;

  constructor() {
    super("The user declined a fresh session token budget.");
  }
}

/** True when the error, or one of its causes, marks a session-limit decline. */
export function isSessionLimitDecline(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();

  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    if ((current as { sessionLimitDeclined?: unknown }).sessionLimitDeclined === true) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }

  return false;
}

/** True when the error, or one of its causes, is a {@link TurnCancelledError}. */
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

/** Throws when the turn signal has aborted. */
export function throwIfTurnAborted(abortSignal: AbortSignal | undefined): void {
  if (abortSignal?.aborted !== true) {
    return;
  }
  if (isTurnCancellation(abortSignal.reason)) {
    throw abortSignal.reason;
  }
  throw new TurnCancelledError();
}
