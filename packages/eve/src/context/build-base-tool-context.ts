import { buildCallbackContext } from "#context/build-callback-context.js";
import type { SessionContext } from "#context/session-context.js";
import { bindSandboxAbortSignal } from "#execution/sandbox/abort-bound-session.js";
import type { ToolExecuteOptions } from "#tools/definition.js";
import { loadContext } from "#context/container.js";
import { BackgroundToolExecutorKey } from "#harness/background-tools.js";
import type { ToolContext } from "#tools/definition.js";

/** Base context shared by tool executors. */
export type BaseToolContext = SessionContext & {
  readonly abortSignal: AbortSignal;
  readonly callId: string;
  readonly toolName: string;
  readonly agent: ToolContext["agent"];
};

/** Builds the base context for one tool execution. */
export function buildBaseToolContext(input: {
  readonly options: Pick<ToolExecuteOptions, "abortSignal" | "toolCallId">;
  readonly toolName: string;
}): BaseToolContext {
  const callbackContext = buildCallbackContext();
  const signal = input.options.abortSignal ?? new AbortController().signal;
  let agentCallIndex = 0;

  return {
    ...callbackContext,
    agent: async (target, agentInput) => {
      signal.throwIfAborted();
      const executor = loadContext().require(BackgroundToolExecutorKey);
      if (!executor.invokeAgent)
        throw new Error("Agent invocation is unavailable in this callback.");
      return executor.invokeAgent(target, agentInput, {
        abortSignal: signal,
        toolCallId: `${input.options.toolCallId}:agent:${agentCallIndex++}`,
        messages: [],
      });
    },
    abortSignal: signal,
    callId: input.options.toolCallId,
    getSandbox: async () => bindSandboxAbortSignal(await callbackContext.getSandbox(), signal),
    toolName: input.toolName,
  };
}
