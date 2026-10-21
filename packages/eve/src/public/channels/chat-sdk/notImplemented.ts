import type { Logger } from "#internal/logging.js";

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

/**
 * Records a failed `editMessage`. `NotImplementedError` means the adapter can't
 * edit at all, so edits stop for the rest of the session; any other failure is
 * logged and affects only the edit that failed. Either way the caller posts the
 * update as a new message.
 */
export function recordEditFailure(
  state: { editSupported?: boolean },
  error: unknown,
  log: Logger,
): void {
  if (isNotImplemented(error)) {
    state.editSupported = false;
    return;
  }
  log.warn("edit failed; posting a new message instead", { error });
}
