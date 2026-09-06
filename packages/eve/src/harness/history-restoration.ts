import type { HarnessSession } from "#harness/types.js";

/** Restores the exact model-history prefix ending at `index`. */
export function restoreSessionHistory(session: HarnessSession, index: number): HarnessSession {
  validateHistoryRestoreIndex(session.history.length, index);
  return { ...session, history: session.history.slice(0, index) };
}

/** Validates an index used as the exclusive end of a model-history prefix. */
export function validateHistoryRestoreIndex(historyLength: number, index: number): void {
  if (!Number.isInteger(index) || index < 0 || index > historyLength) {
    throw new RangeError(
      `History restoration index must be an integer from 0 through ${historyLength}; received ${String(index)}.`,
    );
  }
}
