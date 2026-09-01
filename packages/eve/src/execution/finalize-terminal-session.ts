import type { TurnCaller } from "#channel/types.js";
import {
  notifyDelegatedParentStep,
  notifyTurnCallerStep,
} from "#execution/delegated-parent-notification.js";
import { createDelegatedSubagentSuccessResult } from "#execution/delegated-parent-result.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { fireSessionCallbackStep } from "#execution/session-callback-step.js";
import { emitTerminalSessionCompletionStep } from "#execution/terminal-session-completion-step.js";
import { terminateChildSessionsStep } from "#execution/terminate-child-sessions-step.js";
import type { RunMode } from "#shared/run-mode.js";

/** Completes a session that terminates outside a turn. */
export async function finalizeTerminalSession(input: {
  readonly caller: TurnCaller | undefined;
  readonly driverWritable: WritableStream<Uint8Array>;
  readonly mode: RunMode;
  readonly notifyCaller: boolean;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly terminalState: { terminalEmitted: boolean };
}): Promise<{ readonly output: unknown }> {
  await terminateChildSessionsStep({
    serializedContext: input.serializedContext,
    sessionState: input.sessionState,
  });
  await emitTerminalSessionCompletionStep({
    parentWritable: input.driverWritable,
    serializedContext: input.serializedContext,
  });
  input.terminalState.terminalEmitted = true;

  if (!input.notifyCaller) return { output: "" };

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
