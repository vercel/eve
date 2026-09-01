import type { TurnCaller } from "#channel/types.js";
import { notifyDelegatedParentStep, notifyTurnCallerStep } from "#subagents/parent-notification.js";
import {
  createDelegatedSubagentErrorResult,
  createDelegatedSubagentSuccessResult,
} from "#subagents/parent-result.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { NextDriverAction } from "#execution/next-driver-action.js";
import { fireSessionCallbackStep } from "#subagents/callback-step.js";
import { emitTerminalSessionCompletionStep } from "#execution/terminal-session-completion-step.js";
import { terminateChildSessionsStep } from "#execution/terminate-child-sessions-step.js";
import type { RunMode } from "#shared/run-mode.js";
import type { TokenUsage } from "#shared/token-usage.js";

export async function finalizeExpiredSession(input: {
  readonly caller: TurnCaller | undefined;
  readonly driverWritable: WritableStream<Uint8Array>;
  readonly mode: RunMode;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<{ readonly output: unknown }> {
  await terminateChildSessionsStep({
    serializedContext: input.serializedContext,
    sessionState: input.sessionState,
  });
  await emitTerminalSessionCompletionStep({
    parentWritable: input.driverWritable,
    serializedContext: input.serializedContext,
  });

  if (input.mode === "task") {
    await fireSessionCallbackStep({
      output: "",
      serializedContext: input.serializedContext,
      status: "completed",
    });
    await notifyDelegatedParentStep({
      result: createDelegatedSubagentSuccessResult(input.serializedContext, ""),
      serializedContext: input.serializedContext,
    });
  } else if (input.caller !== undefined) {
    await notifyTurnCallerStep({
      caller: input.caller,
      lifecycle: "terminal",
      sessionId: input.sessionState.sessionId,
      settled: { output: "" },
    });
  }
  return { output: "" };
}

export async function finalizeDone(input: {
  readonly action: NextDriverAction & { readonly kind: "done" };
  readonly caller: TurnCaller | undefined;
  readonly mode: RunMode;
}): Promise<{ readonly output: unknown }> {
  const { output, serializedContext } = input.action;
  const failed = input.action.isError === true;

  await terminateChildSessionsStep({
    serializedContext,
    sessionState: input.action.sessionState,
  });
  if (input.mode === "task") {
    await fireSessionCallbackStep({
      error: failed ? output : undefined,
      output: failed ? undefined : output,
      serializedContext,
      status: failed ? "failed" : "completed",
      usage: input.action.usage,
    });
    await notifyDelegatedParentStep({
      result: failed
        ? createDelegatedSubagentErrorResult(serializedContext, output)
        : createDelegatedSubagentSuccessResult(serializedContext, output),
      serializedContext,
      usage: input.action.usage,
    });
  } else {
    const settled: {
      isError?: boolean;
      output: unknown;
      usage?: TokenUsage;
    } = { output, usage: input.action.usageDelta };
    if (failed) {
      settled.isError = true;
    }
    if (input.caller !== undefined) {
      await notifyTurnCallerStep({
        caller: input.caller,
        lifecycle: "terminal",
        sessionId: input.action.sessionState.sessionId,
        settled,
      });
    }
  }
  return { output };
}
