import type { Cause } from "#protocol/session-events/envelope.js";
import type { ControlDelivery, SettledTurn } from "#harness/types.js";
import type { ControlSettlement } from "#harness/facts.js";
import { latestTurnIdOf, turnCoordinatesOf } from "#protocol/session-projection.js";
import type { TurnCaller } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { closeSessionStreamStep } from "#execution/close-session-stream-step.js";
import { emitTerminalSessionCompletionStep } from "#execution/terminal-session-completion-step.js";
import {
  endSessionSandboxStep,
  reportSessionSandboxCleanupFailureStep,
} from "#execution/session/end-sandbox-step.js";
import { emitTerminalSessionFailureStep } from "#execution/terminal-session-failure-step.js";
import {
  reportChildSessionTeardownFailureStep,
  terminateChildSessionsStep,
} from "#execution/terminate-child-sessions-step.js";
import { liveRuns } from "#execution/tasks/table.js";
import type { TurnOutcome } from "#execution/session/turn-step-types.js";
import { normalizeSerializableError } from "#execution/workflow-errors.js";
import type { WorkflowEntryResult } from "#execution/session/entry-input.js";
import type { TokenUsage } from "#shared/token-usage.js";
import { storedProjection } from "#harness/session-machine/view.js";
import { sessionUsage, takeSessionUsageDelta } from "#harness/session-usage.js";
import {
  notifyCancelledTaskCallerStep,
  notifyTurnCallerStep,
} from "#subagents/parent-notification.js";

export type SessionTerminalOutcome =
  | { readonly kind: "done"; readonly action: TurnOutcome & { readonly kind: "done" } }
  | {
      readonly kind: "ended";
      readonly cause?: Cause;
      readonly settles?: readonly ControlSettlement[];
      readonly settled?: SettledTurn;
      readonly cancelled?: { readonly usage?: TokenUsage };
    }
  | {
      readonly kind: "expired";
      readonly control?: ControlDelivery;
      readonly settles?: readonly ControlSettlement[];
    }
  | { readonly kind: "failed"; readonly error: unknown; readonly turnId?: string };

interface SessionFinalizationContext {
  readonly caller: TurnCaller | undefined;
  readonly cursor: {
    readonly serializedContext: Record<string, unknown>;
    readonly sessionState: DurableSessionState | undefined;
  };
  readonly sessionWritable: WritableStream<Uint8Array>;
}

function mayHaveLiveRuns(sessionState: DurableSessionState): boolean {
  try {
    return liveRuns(sessionState.snapshot?.session?.state).length > 0;
  } catch {
    return true;
  }
}

export async function finalizeSession(
  outcome: SessionTerminalOutcome,
  context: SessionFinalizationContext,
): Promise<WorkflowEntryResult> {
  const { serializedContext, sessionState } = context.cursor;
  if (sessionState !== undefined && mayHaveLiveRuns(sessionState)) {
    try {
      await terminateChildSessionsStep({ sessionState });
    } catch (error) {
      await reportChildSessionTeardownFailureStep({
        error: normalizeSerializableError(error),
        parentSessionId: sessionState.sessionId,
      }).catch(() => undefined);
    }
  }
  if (sessionState !== undefined) {
    try {
      await endSessionSandboxStep({
        reason: outcome.kind === "done" || outcome.kind === "ended" ? "completed" : outcome.kind,
        serializedContext,
        sessionState,
      });
    } catch (error) {
      await reportSessionSandboxCleanupFailureStep({
        error: normalizeSerializableError(error),
        outcome: outcome.kind,
        sessionId: sessionState.sessionId,
      }).catch(() => undefined);
    }
  }
  const session = sessionState?.snapshot.session;
  const usage = session === undefined ? undefined : sessionUsage(session);
  const stored = storedProjection(session?.state);
  const latestTurnId = latestTurnIdOf(stored);
  const latest = latestTurnId === undefined ? undefined : turnCoordinatesOf(stored, latestTurnId);
  const settled = settledResult(outcome, context);
  if (outcome.kind === "done" && context.caller !== undefined) {
    const sessionId = sessionState?.sessionId ?? (serializedContext["eve.sessionId"] as string);
    const [closeResult, notifyResult] = await Promise.allSettled([
      closeSessionStreamStep({ sessionWritable: context.sessionWritable }),
      notifyTurnCallerStep({
        caller: context.caller,
        lifecycle: "terminal",
        sessionId,
        settled: {
          ...(settled.isError && { isError: true }),
          output: settled.output,
          usage: settled.turnUsage,
        },
      }),
    ]);
    if (closeResult.status === "rejected") throw closeResult.reason;
    if (notifyResult.status === "rejected") throw notifyResult.reason;
    return {
      isError: outcome.action.isError,
      output: outcome.action.output,
      usage: outcome.action.usage,
      usageDelta: outcome.action.usageDelta,
    };
  }
  if (outcome.kind === "expired" || outcome.kind === "ended") {
    await emitTerminalSessionCompletionStep({
      cause: outcome.kind === "ended" ? outcome.cause : undefined,
      control: outcome.kind === "expired" ? outcome.control : undefined,
      settles: outcome.settles,
      projection: stored,
      sessionState,
      sessionWritable: context.sessionWritable,
      serializedContext,
      turn: latest && { id: latest.turnId, sequence: latest.sequence },
      usage,
    });
  } else if (outcome.kind === "failed") {
    await emitTerminalSessionFailureStep({
      error: normalizeSerializableError(outcome.error),
      sessionState,
      projection: stored,
      sessionWritable: context.sessionWritable,
      serializedContext,
      turnId: outcome.turnId ?? latest?.turnId,
      usage,
    });
  } else {
    await closeSessionStreamStep({ sessionWritable: context.sessionWritable });
  }

  if (context.caller !== undefined) {
    const sessionId = sessionState?.sessionId ?? (serializedContext["eve.sessionId"] as string);
    if (outcome.kind === "ended" && outcome.cancelled !== undefined) {
      const notification = {
        caller: context.caller,
        lifecycle: "terminal" as const,
        sessionId,
      };
      await notifyCancelledTaskCallerStep(
        outcome.cancelled.usage === undefined
          ? notification
          : { ...notification, usage: outcome.cancelled.usage },
      );
    } else {
      const notification: { isError?: boolean; output: unknown; usage?: TokenUsage } = {
        output: settled.output,
        usage: settled.turnUsage,
      };
      if (settled.isError) notification.isError = true;
      await notifyTurnCallerStep({
        caller: context.caller,
        lifecycle: "terminal",
        sessionId,
        settled: notification,
      });
    }
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
          sessionUsage: sessionUsage(session),
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
    case "ended":
      if (outcome.cancelled !== undefined) {
        return {
          isError: true,
          output: "The agent invocation was cancelled.",
          ...(session !== undefined && { sessionUsage: sessionUsage(session) }),
          ...(outcome.cancelled.usage !== undefined && { turnUsage: outcome.cancelled.usage }),
        };
      }
      if (outcome.settled !== undefined) {
        return {
          isError: outcome.settled.isError === true,
          output: outcome.settled.output,
          ...(session !== undefined && { sessionUsage: sessionUsage(session) }),
          ...(outcome.settled.usage !== undefined && { turnUsage: outcome.settled.usage }),
        };
      }
      return context.caller === undefined
        ? { isError: false, output: "" }
        : {
            isError: true,
            output: "The session ended before the delegated task completed.",
            ...usage,
          };
    case "expired":
      return context.caller === undefined
        ? { isError: false, output: "" }
        : {
            isError: true,
            output: "The session ended before the delegated task completed.",
            ...usage,
          };
    case "failed":
      return { isError: true, output: normalizeSerializableError(outcome.error), ...usage };
  }
}
