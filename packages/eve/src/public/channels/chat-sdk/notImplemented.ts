/**
 * True when `error` signals a Chat SDK operation the active adapter does not
 * support. Matched by both `name` and `code` so optional capabilities such as
 * typing indicators and streaming edits can degrade gracefully instead of
 * failing the whole event handler.
 */
export function isNotImplemented(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "NotImplementedError" ||
      (error as { code?: unknown }).code === "NOT_IMPLEMENTED")
  );
}
