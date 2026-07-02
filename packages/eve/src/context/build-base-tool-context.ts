import { buildCallbackContext } from "#context/build-callback-context.js";
import type { SessionContext } from "#public/definitions/callback-context.js";

/**
 * Session context extended with the turn's cooperative cancellation
 * signal — the base every tool-facing context builds on.
 */
export type BaseToolContext = SessionContext & {
  readonly abortSignal: AbortSignal;
};

/**
 * Builds the base context for one tool execution.
 *
 * `abortSignal` is always present so authored tools are written once and
 * work unchanged when a cancellation trigger exists: callers without a
 * turn signal get a fresh inert signal that never aborts. Fresh per call
 * so listeners added by one tool execution cannot accumulate on a shared
 * signal.
 */
export function buildBaseToolContext(abortSignal: AbortSignal | undefined): BaseToolContext {
  return {
    ...buildCallbackContext(),
    abortSignal: abortSignal ?? new AbortController().signal,
  };
}
