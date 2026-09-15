import type { TurnCaller } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { emitTerminalSessionCompletionStep } from "#execution/terminal-session-completion-step.js";
import { emitTerminalSessionFailureStep } from "#execution/terminal-session-failure-step.js";
import { terminateChildSessionsStep } from "#execution/terminate-child-sessions-step.js";
import type { TurnOutcome } from "#execution/session/turn-step-types.js";
import { normalizeSerializableError } from "#execution/workflow-errors.js";
import type { WorkflowEntryResult } from "#execution/session/entry-input.js";
import type { RunMode } from "#shared/run-mode.js";
import type { TokenUsage } from "#shared/token-usage.js";
import { fireSessionCallbackStep } from "#subagents/callback-step.js";
import { notifyDelegatedParentStep, notifyTurnCallerStep } from "#subagents/parent-notification.js";
import {
  createDelegatedSubagentErrorResult,
  createDelegatedSubagentSuccessResult,
} from "#subagents/parent-result.js";

/** The three ways a session ends. `done` already emitted its terminal event inside the turn. */
export type SessionTerminalOutcome =
  | { readonly kind: "done"; readonly action: TurnOutcome & { readonly kind: "done" } }
  | { readonly kind: "expired" }
  | { readonly kind: "failed"; readonly error: unknown; readonly turnId?: string };

export interface SessionFinalizationContext {
  readonly caller: TurnCaller | undefined;
  readonly cursor: {
    readonly serializedContext: Record<string, unknown>;
    readonly sessionState: DurableSessionState | undefined;
  };
  readonly mode: RunMode;
  readonly sessionWritable: WritableStream<Uint8Array>;
}

/**
 * Terminates descendants, emits the terminal protocol event when the turn has
 * not already done so, then settles whoever is waiting on this session: the
 * task callback and delegated parent in task mode, or the parked caller.
 */
export async function finalizeSession(
  outcome: SessionTerminalOutcome,
  context: SessionFinalizationContext,
): Promise<WorkflowEntryResult> {
  const { serializedContext, sessionState } = context.cursor;
  if (sessionState !== undefined) {
    await terminateChildSessionsStep({ serializedContext, sessionState });
  }
  if (outcome.kind === "expired") {
    await emitTerminalSessionCompletionStep({
      parentWritable: context.sessionWritable,
      serializedContext,
    });
  } else if (outcome.kind === "failed") {
    await emitTerminalSessionFailureStep({
      error: normalizeSerializableError(outcome.error),
      parentWritable: context.sessionWritable,
      serializedContext,
      turnId: outcome.turnId,
    });
  }

  const settled = settledResult(outcome);
  if (context.mode === "task") {
    await fireSessionCallbackStep({
      error: settled.isError ? settled.output : undefined,
      output: settled.isError ? undefined : settled.output,
      serializedContext,
      status: settled.isError ? "failed" : "completed",
      usage: settled.sessionUsage,
    });
    await notifyDelegatedParentStep({
      result: settled.isError
        ? createDelegatedSubagentErrorResult(serializedContext, settled.output)
        : createDelegatedSubagentSuccessResult(serializedContext, settled.output),
      serializedContext,
      usage: settled.sessionUsage,
    });
  } else if (context.caller !== undefined) {
    const notification: { isError?: boolean; output: unknown; usage?: TokenUsage } = {
      output: settled.output,
      usage: settled.turnUsage,
    };
    if (settled.isError) notification.isError = true;
    await notifyTurnCallerStep({
      caller: context.caller,
      lifecycle: "terminal",
      sessionId: sessionState?.sessionId ?? (serializedContext["eve.sessionId"] as string),
      settled: notification,
    });
  }
  return outcome.kind === "done"
    ? {
        isError: outcome.action.isError,
        output: outcome.action.output,
        usage: outcome.action.usage,
        usageDelta: outcome.action.usageDelta,
      }
    : { isError: settled.isError, output: settled.output };
}

function settledResult(outcome: SessionTerminalOutcome): {
  readonly isError: boolean;
  readonly output: unknown;
  readonly sessionUsage?: TokenUsage;
  readonly turnUsage?: TokenUsage;
} {
  switch (outcome.kind) {
    case "done":
      return {
        isError: outcome.action.isError === true,
        output: outcome.action.output,
        sessionUsage: outcome.action.usage,
        turnUsage: outcome.action.usageDelta,
      };
    case "expired":
      return { isError: false, output: "" };
    case "failed":
      return { isError: true, output: normalizeSerializableError(outcome.error) };
  }
}
