import type { ControlDelivery } from "#harness/types.js";
import type { ControlSettlement } from "#harness/facts.js";
import { latestTurnIdOf, turnCoordinatesOf } from "#protocol/session-projection.js";
import type { TurnCaller } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { SessionStepRunner } from "#execution/session/steps.js";
import { liveRuns } from "#execution/tasks/table.js";
import type { TurnOutcome } from "#execution/session/turn-step-types.js";
import { normalizeSerializableError } from "#execution/workflow-errors.js";
import type { WorkflowEntryResult } from "#execution/session/entry-input.js";
import type { TokenUsage } from "#shared/token-usage.js";
import { storedProjection } from "#harness/session-machine/view.js";
import { sessionUsage, takeSessionUsageDelta } from "#harness/session-usage.js";

export type SessionTerminalOutcome =
  | { readonly kind: "done"; readonly action: TurnOutcome & { readonly kind: "done" } }
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
  readonly steps: SessionStepRunner;
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
  const { host, stepCall } = context.steps;
  if (sessionState !== undefined && mayHaveLiveRuns(sessionState)) {
    try {
      await host.step(
        "terminateChildSessions",
        { sessionState },
        stepCall("terminateChildSessions"),
      );
    } catch (error) {
      await host
        .step(
          "reportChildSessionTeardownFailure",
          { error: normalizeSerializableError(error), parentSessionId: sessionState.sessionId },
          stepCall("reportChildSessionTeardownFailure"),
        )
        .catch(() => undefined);
    }
  }
  if (sessionState !== undefined) {
    try {
      await host.step(
        "endSessionSandbox",
        {
          reason: outcome.kind === "done" ? "completed" : outcome.kind,
          serializedContext,
          sessionState,
        },
        stepCall("endSessionSandbox"),
      );
    } catch (error) {
      await host
        .step(
          "reportSessionSandboxCleanupFailure",
          {
            error: normalizeSerializableError(error),
            outcome: outcome.kind,
            sessionId: sessionState.sessionId,
          },
          stepCall("reportSessionSandboxCleanupFailure"),
        )
        .catch(() => undefined);
    }
  }
  const session = sessionState?.snapshot.session;
  const usage = session === undefined ? undefined : sessionUsage(session);
  const stored = storedProjection(session?.state);
  const latestTurnId = latestTurnIdOf(stored);
  const latest = latestTurnId === undefined ? undefined : turnCoordinatesOf(stored, latestTurnId);
  if (outcome.kind === "expired") {
    await host.step(
      "emitTerminalSessionCompletion",
      {
        control: outcome.control,
        settles: outcome.settles,
        projection: stored,
        sessionState,
        sessionWritable: context.sessionWritable,
        serializedContext,
        turn: latest && { id: latest.turnId, sequence: latest.sequence },
        usage,
      },
      stepCall("emitTerminalSessionCompletion"),
    );
  } else if (outcome.kind === "failed") {
    await host.step(
      "emitTerminalSessionFailure",
      {
        error: normalizeSerializableError(outcome.error),
        sessionState,
        projection: stored,
        sessionWritable: context.sessionWritable,
        serializedContext,
        turnId: outcome.turnId ?? latest?.turnId,
        usage,
      },
      stepCall("emitTerminalSessionFailure"),
    );
  } else {
    await host.step(
      "closeSessionStream",
      { sessionWritable: context.sessionWritable },
      stepCall("closeSessionStream"),
    );
  }

  const settled = settledResult(outcome, context);
  if (context.caller !== undefined) {
    const notification: { isError?: boolean; output: unknown; usage?: TokenUsage } = {
      output: settled.output,
      usage: settled.turnUsage,
    };
    if (settled.isError) notification.isError = true;
    await host.step(
      "notifyTurnCaller",
      {
        caller: context.caller,
        lifecycle: "terminal",
        sessionId: sessionState?.sessionId ?? (serializedContext["eve.sessionId"] as string),
        settled: notification,
      },
      stepCall("notifyTurnCaller"),
    );
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
