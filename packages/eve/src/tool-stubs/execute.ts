import { findStubTarget, stubCallId } from "#tool-stubs/target.js";
import { contextStorage } from "#context/container.js";
import { SessionKey, ToolStubsKey } from "#context/keys.js";
import { ToolStubPlaybackKey, type ToolStubPlayback } from "#context/providers/tool-stubs-key.js";
import type { ToolExecuteOptions } from "#tools/definition.js";
import { isAsyncIterable } from "#shared/async-iterable.js";

/** Tool inputs and approvals have already been checked before a stub can replace execution. */
export function executeWithToolStub(
  tool: string,
  input: unknown,
  options: ToolExecuteOptions,
  execute: () => unknown,
): unknown {
  const stub = contextStubCall(tool, input, options.toolCallId);
  if (stub === undefined) return execute();
  return executeStubbedTool(stub.playback, stub.call, options, execute);
}

async function* executeStubbedTool(
  playback: ToolStubPlayback,
  call: { readonly callId: string; readonly input: unknown; readonly tool: string },
  options: ToolExecuteOptions,
  execute: () => unknown,
): AsyncIterable<unknown> {
  options.abortSignal?.throwIfAborted();
  const result = await playback.call(call);
  if (result.kind === "error") throw new Error(result.error);
  if (result.kind === "stub") {
    yield result.outcome.response;
    return;
  }
  const output = await execute();
  if (isAsyncIterable(output)) yield* output;
  else yield output;
}

function contextStubCall(tool: string, input: unknown, callId: string) {
  const context = contextStorage.getStore();
  if (context === undefined) return undefined;
  const target = findStubTarget(context.get(ToolStubsKey), tool);
  if (target === undefined) return undefined;
  const session = context.require(SessionKey);
  return {
    playback: context.require(ToolStubPlaybackKey),
    call: {
      tool: target.tool,
      input,
      callId: stubCallId(session.sessionId, session.turn.id, callId),
    },
  };
}

/** Record errors converting stub responses so eval verification can detect them. */
export async function recordToolStubFailure(
  tool: string,
  callId: string | undefined,
  turnId?: string,
): Promise<void> {
  const context = contextStorage.getStore();
  const scope = context?.get(ToolStubsKey);
  if (scope === undefined || callId === undefined) return;
  if (findStubTarget(scope, tool) === undefined) return;
  const session = context!.require(SessionKey);
  await context!
    .require(ToolStubPlaybackKey)
    .fail(
      stubCallId(session.sessionId, turnId ?? session.turn.id, callId),
      `Stubbed tool "${tool}" failed during output processing.`,
    );
}

/** Record stub failures even when the caller recovers with fallback output. */
export async function observeToolOutput<T>(
  tool: string,
  calls: readonly { readonly callId: string; readonly turnId?: string }[],
  project: () => T | Promise<T>,
  recover?: (error: unknown) => T,
): Promise<T> {
  try {
    return await project();
  } catch (error) {
    try {
      for (const call of calls) await recordToolStubFailure(tool, call.callId, call.turnId);
    } catch (reportingError) {
      throw new AggregateError(
        [error, reportingError],
        "Tool output processing and failure reporting failed.",
        { cause: error },
      );
    }
    if (recover !== undefined) return recover(error);
    throw error;
  }
}
