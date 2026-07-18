import { buildCallbackContext } from "#context/build-callback-context.js";
import type { SessionContext } from "#public/definitions/callback-context.js";
import { bindSandboxAbortSignal } from "#execution/sandbox/abort-bound-session.js";
import type { ToolExecuteOptions } from "#shared/tool-definition.js";

/** Base context shared by tool executors. */
export type BaseToolContext = SessionContext & {
  readonly abortSignal: AbortSignal;
  readonly callId: string;
  readonly toolName: string;
};

/** Builds the base context for one tool execution. */
export function buildBaseToolContext(input: {
  readonly options: Pick<ToolExecuteOptions, "abortSignal" | "toolCallId">;
  readonly toolName: string;
}): BaseToolContext {
  const callbackContext = buildCallbackContext();
  const signal = input.options.abortSignal ?? new AbortController().signal;

  return {
    ...callbackContext,
    abortSignal: signal,
    callId: input.options.toolCallId,
    getSandbox: async () => bindSandboxAbortSignal(await callbackContext.getSandbox(), signal),
    toolName: input.toolName,
  };
}
