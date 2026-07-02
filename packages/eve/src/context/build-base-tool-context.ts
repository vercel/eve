import { buildCallbackContext } from "#context/build-callback-context.js";
import type { SessionContext } from "#public/definitions/callback-context.js";
import { bindSandboxAbortSignal } from "#execution/sandbox/abort-bound-session.js";

/** Base context shared by tool executors. */
export type BaseToolContext = SessionContext & {
  readonly abortSignal: AbortSignal;
};

/** Builds the base context for one tool execution. */
export function buildBaseToolContext(abortSignal: AbortSignal | undefined): BaseToolContext {
  const callbackContext = buildCallbackContext();
  const signal = abortSignal ?? new AbortController().signal;

  return {
    ...callbackContext,
    abortSignal: signal,
    getSandbox: async () => bindSandboxAbortSignal(await callbackContext.getSandbox(), signal),
  };
}
