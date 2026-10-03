import type { HumanInput } from "#harness/human-input/index.js";

const TURN_CANCELLED_ERROR_NAME = "TurnCancelledError";

/** Terminal outcome of a cancelled turn. */
export class TurnCancelledError extends Error {
  constructor(message = "The turn was cancelled.") {
    super(message);
    this.name = TURN_CANCELLED_ERROR_NAME;
  }
}

/**
 * The person answered the budget question with Stop. A decision, not an
 * error: the turn settles through the standard cancellation path.
 */
export class SessionLimitDeclinedError extends TurnCancelledError {
  readonly requestId: string;
  /**
   * Human input after Stop resolved the question. A cancelled step keeps none
   * of its own state, so the cancel writes this back rather than withdraw the
   * question a second time.
   */
  readonly humanInput: HumanInput;

  constructor(requestId: string, humanInput: HumanInput) {
    super("The user declined a fresh session token budget.");
    this.requestId = requestId;
    this.humanInput = humanInput;
  }
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
