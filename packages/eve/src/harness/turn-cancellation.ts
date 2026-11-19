const TURN_CANCELLED_ERROR_NAME = "TurnCancelledError";

export class TurnCancelledError extends Error {
  constructor(message = "The turn was cancelled.") {
    super(message);
    this.name = TURN_CANCELLED_ERROR_NAME;
  }
}

export class SessionLimitDeclinedError extends TurnCancelledError {
  constructor() {
    super("The user declined a fresh session token budget.");
  }
}

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

export function withTurnCancellationReason(signal: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const abort = () =>
    controller.abort(isTurnCancellation(signal.reason) ? signal.reason : new TurnCancelledError());
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

export function throwIfTurnAborted(abortSignal: AbortSignal | undefined): void {
  if (abortSignal?.aborted !== true) {
    return;
  }
  if (isTurnCancellation(abortSignal.reason)) {
    throw abortSignal.reason;
  }
  throw new TurnCancelledError();
}
