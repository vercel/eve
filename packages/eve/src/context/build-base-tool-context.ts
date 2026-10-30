import { buildCallbackContext } from "#context/build-callback-context.js";
import type { SessionContext } from "#context/session-context.js";
import { bindSandboxAbortSignal } from "#execution/sandbox/abort-bound-session.js";
import type { SandboxEnvironment } from "#shared/sandbox-environment.js";
import type { ToolExecuteOptions } from "#tools/definition.js";

/** Base context shared by tool executors. */
type BaseToolContext = SessionContext & {
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

  const getSandbox = (async (environment?: SandboxEnvironment) =>
    bindSandboxAbortSignal(
      await (environment === undefined
        ? callbackContext.getSandbox()
        : callbackContext.getSandbox(environment)),
      signal,
    )) as SessionContext["getSandbox"];

  return {
    ...callbackContext,
    abortSignal: signal,
    callId: input.options.toolCallId,
    getSandbox,
    toolName: input.toolName,
  };
}
