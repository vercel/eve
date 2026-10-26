import { SessionStrandedError } from "#channel/session-stranded-error.js";

/**
 * Thrown by `respond()` when no session holds the address it answers, such as
 * after the session's run was cancelled outside eve, so the requests being
 * answered no longer exist. Nothing is delivered. Narrow with
 * {@link SessionNotActiveError.is}.
 */
export class SessionNotActiveError extends Error {
  constructor() {
    super(
      "Cannot deliver inputResponses — the target session was not found via continuation token.",
    );
    this.name = "SessionNotActiveError";
  }

  /** Narrows not-active-session errors across bundle boundaries, where `instanceof` can miss. */
  static is(error: unknown): error is SessionNotActiveError {
    return (
      error instanceof SessionNotActiveError ||
      (typeof error === "object" &&
        error !== null &&
        Reflect.get(error, "name") === "SessionNotActiveError")
    );
  }
}

/**
 * Whether a failed `respond()` can never succeed: no session holds the
 * requests, or the session holding them is stranded and can run no code.
 */
export function isUnanswerableResponseError(error: unknown): boolean {
  return SessionNotActiveError.is(error) || SessionStrandedError.is(error);
}
