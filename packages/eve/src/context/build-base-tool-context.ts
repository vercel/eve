import { buildCallbackContext } from "#context/build-callback-context.js";
import type { SessionContext } from "#public/definitions/callback-context.js";
import { bindSandboxAbortSignal } from "#execution/sandbox/abort-bound-session.js";
import type { ToolExecuteOptions } from "#shared/tool-definition.js";

/** Base context shared by tool executors. */
export type BaseToolContext = SessionContext & {
  readonly abortSignal: AbortSignal;
  readonly callId: string;
};

/** Builds the base context for one tool execution. */
export function buildBaseToolContext(
  options: Pick<ToolExecuteOptions, "abortSignal" | "toolCallId">,
): BaseToolContext {
  const callbackContext = buildCallbackContext();
  const signal = options.abortSignal ?? new AbortController().signal;

  return {
    ...callbackContext,
    abortSignal: signal,
    callId: options.toolCallId,
    getSandbox: async () => bindSandboxAbortSignal(await callbackContext.getSandbox(), signal),
  };
}
