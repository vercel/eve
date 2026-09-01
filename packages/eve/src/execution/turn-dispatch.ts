import type { DeliverHookPayload, HookPayload, SessionCapabilities } from "#channel/types.js";
import { dispatchTurnStep } from "#execution/dispatch-turn-step.js";
import { TurnControlReceiver } from "#execution/turn-control-receiver.js";
import {
  rebuildSerializableError,
  normalizeSerializableError,
} from "#execution/workflow-errors.js";
import { getRun } from "#compiled/@workflow/core/runtime.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { SessionCommandInbox } from "#execution/session-command-inbox.js";
import type { TurnDriverAction } from "#execution/turn-control-receiver.js";
import type { RunMode } from "#shared/run-mode.js";
import { activeTurnId } from "#harness/active-turn-id.js";

/** A turn run ended without publishing its required terminal control message. */
class TurnWorkflowTerminalError extends Error {
  readonly runId: string;

  constructor(runId: string, cause: unknown) {
    super(`Turn workflow ${runId} terminated before reporting a result.`, { cause });
    this.name = "TurnWorkflowTerminalError";
    this.runId = runId;
  }
}

/** One settled turn: its terminal driver action plus deferred hook cleanup. */
export interface DispatchedTurn {
  readonly action: TurnDriverAction;
  /**
   * Disposes the turn's control hook. Deferred until the *next* turn
   * settles (or the session ends): the turn run's final control send is
   * at-least-once, and `sendTurnControlStep` does not treat
   * `HookNotFoundError` as benign, so a late duplicate resume must land
   * on a live hook. By the next settle, the previous run has completed
   * and can no longer re-send.
   */
  dispose(): Promise<void>;
}

/** Dispatches one turn and services its private-inbox control protocol until it terminates. */
export async function dispatchAndAwaitTurn(input: {
  readonly bufferedDeliveries: DeliverHookPayload[];
  readonly bufferedSessionControls: Array<"clear" | "compact" | "expired" | "reset">;
  readonly capabilities?: SessionCapabilities;
  readonly cancelledTaskIds?: Set<string>;
  readonly controlToken: string;
  readonly delivery: HookPayload;
  readonly commandInbox: SessionCommandInbox;
  readonly mode: RunMode;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly seenTaskDeliveries?: Set<string>;
  readonly sessionState: DurableSessionState;
}): Promise<DispatchedTurn> {
  const control = new TurnControlReceiver({
    bufferedDeliveries: input.bufferedDeliveries,
    bufferedSessionControls: input.bufferedSessionControls,
    cancelledTaskIds: input.cancelledTaskIds,
    commandInbox: input.commandInbox,
    expectedTurnId: activeTurnId(input.sessionState.emissionState),
    seenTaskDeliveries: input.seenTaskDeliveries ?? new Set(),
    token: input.controlToken,
  });

  try {
    const { runId } = await dispatchTurnStep({
      capabilities: input.capabilities,
      completionToken: control.token,
      delivery: input.delivery,
      mode: input.mode,
      parentWritable: input.parentWritable,
      serializedContext: input.serializedContext,
      sessionState: input.sessionState,
    });
    const controlAction = control.waitForAction();
    const childOutcome = getRun(runId).returnValue.then(
      () => ({ kind: "child-completed" as const }),
      (error) => ({ error: normalizeSerializableError(error), kind: "child-failed" as const }),
    );
    const outcome = await Promise.race([
      controlAction.then((action) => ({ action, kind: "control" as const })),
      childOutcome,
    ]);

    if (outcome.kind === "control") {
      return { action: outcome.action, dispose: () => control.dispose() };
    }
    if (outcome.kind === "child-failed") {
      throw new TurnWorkflowTerminalError(runId, rebuildSerializableError(outcome.error));
    }

    // The terminal control send precedes a successful return, but its hook
    // delivery may lose this scheduling race. Reuse the existing consumer.
    const action = await controlAction;
    return { action, dispose: () => control.dispose() };
  } catch (error) {
    await control.dispose();
    throw error;
  }
}
