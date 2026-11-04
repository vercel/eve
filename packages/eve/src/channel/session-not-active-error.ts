import { EveError } from "#shared/eve-error.js";
import { SessionStrandedError } from "#channel/session-stranded-error.js";

/**
 * A session could not accept a command. No delivery was accepted.
 *
 * `code` is the HTTP channel's `409` code: `session_not_ready` (with `retryable: true`) while an
 * accepted session is still starting, otherwise `session_not_active`.
 */
export class SessionNotActiveError extends EveError {
  static override readonly errorName = "SessionNotActiveError";
  declare readonly code: "session_not_active" | "session_not_ready";
  readonly retryable: boolean;

  constructor(options: { readonly retryable?: boolean } = {}) {
    const retryable = options.retryable === true;
    super(
      retryable ? "session_not_ready" : "session_not_active",
      retryable
        ? "The session is not ready to accept commands. Retry shortly."
        : "The session is no longer active. Start a new session.",
    );
    this.retryable = retryable;
  }
}

/** Whether an answer targets a session that cannot run or no longer exists. */
export function isUnanswerableResponseError(error: unknown): boolean {
  return SessionNotActiveError.is(error) || SessionStrandedError.is(error);
}
