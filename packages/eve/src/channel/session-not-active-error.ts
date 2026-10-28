import { SessionStrandedError } from "#channel/session-stranded-error.js";

const CODE = "EVE_SESSION_NOT_ACTIVE";

/** A session could not accept a command. No delivery was accepted. */
export class SessionNotActiveError extends Error {
  readonly code = CODE;
  readonly retryable: boolean;

  constructor(options: { readonly retryable?: boolean } = {}) {
    super(
      options.retryable === true
        ? "The session is not ready to accept commands. Retry shortly."
        : "The session is no longer active. Start a new session.",
    );
    this.name = "SessionNotActiveError";
    this.retryable = options.retryable === true;
  }

  /** Recognizes errors across bundles without depending on constructor identity. */
  static is(error: unknown): error is SessionNotActiveError {
    return (
      error !== null &&
      typeof error === "object" &&
      Reflect.get(error, "code") === CODE &&
      typeof Reflect.get(error, "retryable") === "boolean"
    );
  }
}

/** Whether an answer targets a session that cannot run or no longer exists. */
export function isUnanswerableResponseError(error: unknown): boolean {
  return SessionNotActiveError.is(error) || SessionStrandedError.is(error);
}
