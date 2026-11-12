/**
 * A write to the session stream failed. The stream is errored from then on, so nothing more the
 * step writes can reach it: the step rethrows this at once, without retrying, recovering, or
 * reporting a failure, and Workflow retries the step with a fresh stream. An aborted write keeps
 * the name `AbortError`, so Workflow still reads it as aborted.
 */
export class SessionStreamWriteError extends Error {
  constructor(cause: unknown) {
    super(
      `A session stream write failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name =
      cause instanceof Error && cause.name === "AbortError"
        ? "AbortError"
        : "SessionStreamWriteError";
  }
}

/** Rethrows the {@link SessionStreamWriteError} `error` is, or carries on its cause chain. */
export function throwIfSessionStreamDead(error: unknown): void {
  const seen = new Set<unknown>();
  for (let current = error; typeof current === "object" && current !== null;) {
    if (current instanceof SessionStreamWriteError) throw current;
    if (seen.has(current)) return;
    seen.add(current);
    current = (current as { readonly cause?: unknown }).cause;
  }
}
