/** Default lifetime from creation or the latest successful ownership handoff. */
export const DEFAULT_SESSION_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1_000;

export function sessionTimeoutDeadline(
  timeoutMs: number | false,
  startedAtMs: number,
): Date | undefined {
  return timeoutMs === false ? undefined : new Date(startedAtMs + timeoutMs);
}
