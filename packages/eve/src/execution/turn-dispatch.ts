import type { DeliverHookPayload, HookPayload, SessionCapabilities } from "#channel/types.js";
import { dispatchTurnStep } from "#execution/dispatch-turn-step.js";
import { TurnControlReceiver } from "#execution/turn-control-receiver.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import {
  createTurnWorkflowInput,
  type InitialTurnStep,
  type TurnWorkflowDispatchInput,
} from "#execution/durable-session-migrations/turn-workflow.js";
import { runInlineTurn } from "#execution/inline-turn.js";
import type { SessionCommandInbox } from "#execution/session-command-inbox.js";
import { SessionStateCursor } from "#execution/session-state-cursor.js";
import type { TurnCancelPayload } from "#execution/turn-cancellation-token.js";
import type { TurnDriverAction } from "#execution/turn-control-receiver.js";
import type { RunMode } from "#shared/run-mode.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import { runTurnOwnedWorkflow } from "#execution/turn-workflow.js";

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
interface TurnDispatchInput {
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
  readonly stateCursor?: SessionStateCursor;
}

export async function dispatchAndAwaitTurn(input: TurnDispatchInput): Promise<DispatchedTurn> {
  const stateCursor =
    input.stateCursor ??
    new SessionStateCursor({
      serializedContext: input.serializedContext,
      sessionState: input.sessionState,
    });
  const inline = await runInlineTurn({ ...input, stateCursor });
  if (inline.kind === "result") {
    return { action: inline.action, async dispose() {} };
  }
  return await runAndAwaitTurn({
    ...input,
    inline: inline.kind === "continue",
    initialCancellation: inline.initialCancellation,
    stateCursor,
    initialStep: inline.initialStep,
  });
}

async function runAndAwaitTurn(
  input: TurnDispatchInput & {
    readonly inline: boolean;
    readonly initialCancellation?: TurnCancelPayload;
    readonly initialStep?: InitialTurnStep;
  },
): Promise<DispatchedTurn> {
  const control = new TurnControlReceiver({
    bufferedDeliveries: input.bufferedDeliveries,
    bufferedSessionControls: input.bufferedSessionControls,
    cancelledTaskIds: input.cancelledTaskIds,
    commandInbox: input.commandInbox,
    expectedTurnId: activeTurnId(input.sessionState.emissionState),
    seenTaskDeliveries: input.seenTaskDeliveries ?? new Set(),
    stateCursor: input.stateCursor!,
    token: input.controlToken,
  });

  try {
    const turnInput = {
      capabilities: input.capabilities,
      completionToken: control.token,
      delivery: input.delivery,
      initialCancellation: input.initialCancellation,
      initialStep: input.initialStep,
      mode: input.mode,
      parentWritable: input.parentWritable,
      serializedContext: input.serializedContext,
      sessionState: input.sessionState,
    } satisfies TurnWorkflowDispatchInput;
    let action: TurnDriverAction;
    if (input.inline) {
      // The parent owns the same hooks and orchestration as a dispatched turn.
      // Service commands concurrently so workflow questions and cancellation can resume it.
      [action] = await Promise.all([
        control.waitForAction(),
        runTurnOwnedWorkflow(createTurnWorkflowInput(turnInput)),
      ]);
    } else {
      await dispatchTurnStep(turnInput);
      action = await control.waitForAction();
    }
    return { action, dispose: () => control.dispose() };
  } catch (error) {
    await control.dispose();
    throw error;
  }
}
