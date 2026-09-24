import type { TurnCaller } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { emitTerminalSessionCompletionStep } from "#execution/terminal-session-completion-step.js";
import { emitTerminalSessionFailureStep } from "#execution/terminal-session-failure-step.js";
import { terminateChildSessionsStep } from "#execution/terminate-child-sessions-step.js";
import type { TurnOutcome } from "#execution/session/turn-step-types.js";
import { normalizeSerializableError } from "#execution/workflow-errors.js";
import type { WorkflowEntryResult } from "#execution/session/entry-input.js";
import type { RunMode } from "#shared/run-mode.js";
import { AGENT_SESSION_ENDED_MESSAGE } from "#tasks/render.js";
import type { TokenUsage } from "#shared/token-usage.js";
import { getSessionTokenUsage, takeSessionUsageDelta, toUsage } from "#harness/turn-tag-state.js";
import { fireSessionCallbackStep } from "#subagents/remote/callback-step.js";
import { notifyTurnCallerStep } from "#tasks/child.js";
import { getHarnessEmissionState } from "#harness/emission-state.js";
import { answerOrder } from "#tasks/protocol.js";

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
 * task callback in task mode, or the parked caller.
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
      sessionWritable: context.sessionWritable,
      serializedContext,
    });
  } else if (outcome.kind === "failed") {
    await emitTerminalSessionFailureStep({
      error: normalizeSerializableError(outcome.error),
      sessionWritable: context.sessionWritable,
      serializedContext,
      turnId: outcome.turnId,
    });
  }

  const settled = settledResult(outcome, context);
  if (context.mode === "task") {
    await fireSessionCallbackStep({
      error: settled.isError ? settled.output : undefined,
      output: settled.isError ? undefined : settled.output,
      serializedContext,
      status: settled.isError ? "failed" : "completed",
      usage: settled.sessionUsage,
    });
  } else if (context.caller !== undefined) {
    const notification: {
      answer?: number;
      errorCode?: string;
      isError?: boolean;
      output: unknown;
      usage?: TokenUsage;
    } = {
      output: settled.output,
      usage: settled.turnUsage,
    };
    const session = context.cursor.sessionState?.snapshot.session;
    if (session !== undefined) {
      notification.answer = answerOrder(
        getHarnessEmissionState(session.state).sequence,
        "terminal",
      );
    }
    if (settled.isError) notification.isError = true;
    if (settled.errorCode !== undefined) notification.errorCode = settled.errorCode;
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
    : {
        isError: settled.isError,
        output: settled.output,
        usage: settled.sessionUsage,
        usageDelta: settled.turnUsage,
      };
}

function settledResult(
  outcome: SessionTerminalOutcome,
  context: SessionFinalizationContext,
): {
  readonly errorCode?: string;
  readonly isError: boolean;
  readonly output: unknown;
  readonly sessionUsage?: TokenUsage;
  readonly turnUsage?: TokenUsage;
} {
  const session = context.cursor.sessionState?.snapshot.session;
  const usage =
    session === undefined || context.caller === undefined
      ? {}
      : {
          sessionUsage: toUsage(getSessionTokenUsage(session)),
          turnUsage: takeSessionUsageDelta(session).delta,
        };
  switch (outcome.kind) {
    case "done":
      return {
        isError: outcome.action.isError === true,
        output: outcome.action.output,
        sessionUsage: outcome.action.usage,
        turnUsage: outcome.action.usageDelta,
      };
    case "expired":
      return context.caller === undefined
        ? { isError: false, output: "" }
        : {
            errorCode: "AGENT_SESSION_ENDED",
            isError: true,
            output: AGENT_SESSION_ENDED_MESSAGE,
            ...usage,
          };
    case "failed":
      return { isError: true, output: normalizeSerializableError(outcome.error), ...usage };
  }
}
