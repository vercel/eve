import { next } from "#core/turn-step.js";
import type {
  LoopTypes,
  TurnBackend,
  TurnInput,
  TurnOutcome,
  TurnProgramInput,
} from "#core/types.js";

export const TASK_MODE_WAIT_ERROR_MESSAGE =
  "Task mode cannot wait for follow-up input (`next: null`).";

/**
 * Drives one logical turn through its named phases.
 *
 * **Initiate**: the delivery becomes the first step's input. **Advance**:
 * one {@link next} call per step, checkpointing after every non-final
 * step so the driver always holds the latest state. **Settle**: gate an
 * unparkable task-mode wait, then map the completed step onto the turn's
 * outcome. Cancellation surfaces as a value, never as a failure.
 */
export async function runTurn<Types extends LoopTypes>(
  backend: TurnBackend<Types>,
  input: TurnProgramInput<Types>,
): Promise<TurnOutcome<Types>> {
  let state = input.state;
  let stepInput: TurnInput<Types> | undefined = input.delivery;
  let stepOrdinal = 0;

  while (true) {
    const step = await next(backend, { input: stepInput, state, stepOrdinal: stepOrdinal++ });
    state = step.state;

    if (!step.done) {
      await backend.checkpoint(state);
      stepInput = step.nextInput;
      continue;
    }

    if (step.kind === "waiting") {
      const canPark =
        step.hasPendingAuthorization ||
        (step.hasPendingInputBatch && input.capabilities?.requestInput === true) ||
        input.mode === "conversation";
      if (!canPark) throw new Error(TASK_MODE_WAIT_ERROR_MESSAGE);

      return {
        authorizationNames: step.authorizationNames,
        hasPendingAuthorization: step.hasPendingAuthorization,
        hasPendingInputBatch: step.hasPendingInputBatch,
        kind: "waiting",
        state,
      };
    }

    if (step.kind === "cancelled") {
      return { kind: "cancelled", state };
    }

    return {
      isError: step.isError,
      kind: "done",
      output: step.output,
      state,
      usage: step.usage,
    };
  }
}
