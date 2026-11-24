import { buildCallbackContext } from "#context/build-callback-context.js";
import type { GetSandboxOptions, SessionContext } from "#context/session-context.js";
import { bindSandboxAbortSignal } from "#execution/sandbox/abort-bound-session.js";
import type { SandboxEnvironment } from "#shared/sandbox-environment.js";
import type { RuntimeSandboxSession } from "#shared/sandbox-session.js";
import type { ToolExecuteOptions } from "#tools/definition.js";

type BaseToolContext = SessionContext & {
  readonly abortSignal: AbortSignal;
  readonly callId: string;
  readonly toolName: string;
};

export function buildBaseToolContext(input: {
  readonly options: Pick<ToolExecuteOptions, "abortSignal" | "toolCallId">;
  readonly toolName: string;
}): BaseToolContext {
  const callbackContext = buildCallbackContext();
  const signal = input.options.abortSignal ?? new AbortController().signal;

  const getSandbox = (async (
    first?: SandboxEnvironment | GetSandboxOptions,
    second?: GetSandboxOptions,
  ) => {
    const sandbox = await (
      callbackContext.getSandbox as (
        first?: SandboxEnvironment | GetSandboxOptions,
        second?: GetSandboxOptions,
      ) => Promise<RuntimeSandboxSession | null>
    )(first, second);
    return sandbox === null ? null : bindSandboxAbortSignal(sandbox, signal);
  }) as SessionContext["getSandbox"];

  return {
    ...callbackContext,
    abortSignal: signal,
    callId: input.options.toolCallId,
    getSandbox,
    toolName: input.toolName,
  };
}
