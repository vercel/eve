export const DEFAULT_SESSION_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1_000;

/** Terminal error raised when a durable session reaches its configured lifetime. */
export class SessionTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Session timed out after ${formatTimeout(timeoutMs)}.`);
    this.name = "SessionTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

function formatTimeout(timeoutMs: number): string {
  const days = timeoutMs / (24 * 60 * 60 * 1_000);
  if (Number.isInteger(days)) {
    return `${String(days)} ${days === 1 ? "day" : "days"}`;
  }
  return `${String(timeoutMs)}ms`;
}
