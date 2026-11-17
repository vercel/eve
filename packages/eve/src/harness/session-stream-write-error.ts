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

export function throwIfSessionStreamDead(error: unknown): void {
  const seen = new Set<unknown>();
  for (let current = error; typeof current === "object" && current !== null;) {
    if (current instanceof SessionStreamWriteError) throw current;
    if (seen.has(current)) return;
    seen.add(current);
    current = (current as { readonly cause?: unknown }).cause;
  }
}
