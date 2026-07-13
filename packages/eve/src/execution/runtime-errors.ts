/**
 * Thrown by a {@link Runtime}'s `deliver` when no in-flight session
 * matches the continuation token. Callers using the resume-or-start
 * pattern (e.g. {@link createSendFn}) treat this as the signal to start
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
  if (error instanceof RuntimeNoActiveSessionError) {
    return true;
  }
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as Record<string, unknown>;
  return (
    candidate.name === "RuntimeNoActiveSessionError" &&
    candidate.code === "NO_ACTIVE_SESSION" &&
    typeof candidate.continuationToken === "string"
  );
}
