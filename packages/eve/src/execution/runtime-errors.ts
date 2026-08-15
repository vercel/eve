/**
 * Thrown by a {@link Runtime}'s `deliver` when no in-flight session
 * matches the continuation token. Callers using the resume-or-start
 * pattern (e.g. a channel address send) treat this as the signal to start
 * a fresh session.
 */
export class RuntimeNoActiveSessionError extends Error {
  readonly code = "NO_ACTIVE_SESSION" as const;
  readonly continuationToken: string;

  constructor(continuationToken: string) {
    super(`No active session for continuationToken "${continuationToken}".`);
    this.name = "RuntimeNoActiveSessionError";
    this.continuationToken = continuationToken;
  }
}

/** Type guard for {@link RuntimeNoActiveSessionError}. */
export function isRuntimeNoActiveSessionError(
  error: unknown,
): error is RuntimeNoActiveSessionError {
  return error instanceof RuntimeNoActiveSessionError;
}

/** Signals that another session won a concurrent channel-address claim. */
export class RuntimeSessionOwnershipConflictError extends Error {
  readonly continuationToken: string;
  readonly ownerSessionId: string;
  readonly sessionId: string;

  constructor(input: {
    readonly continuationToken: string;
    readonly ownerSessionId: string;
    readonly sessionId: string;
  }) {
    super(
      `Session "${input.sessionId}" lost continuationToken "${input.continuationToken}" ` +
        `to session "${input.ownerSessionId}".`,
    );
    this.name = "RuntimeSessionOwnershipConflictError";
    this.continuationToken = input.continuationToken;
    this.ownerSessionId = input.ownerSessionId;
    this.sessionId = input.sessionId;
  }
}

export function isRuntimeSessionOwnershipConflictError(
  error: unknown,
): error is RuntimeSessionOwnershipConflictError {
  return error instanceof RuntimeSessionOwnershipConflictError;
}
