import { storedProjection } from "#harness/session-machine/view.js";
import { waitsOnAnything } from "#execution/session/pending-turn-state.js";
import type { HarnessSession, HarnessStepInput, StepResult } from "#harness/types.js";
import type { SessionProjection } from "#protocol/session-projection.js";

export function canContinueModelCallBatch(input: {
  readonly lastCall: boolean;
  readonly steeringSignal?: AbortSignal;
  readonly result: StepResult;
  readonly projection: SessionProjection;
}): boolean {
  if (
    input.lastCall ||
    input.steeringSignal?.aborted === true ||
    input.result.steered === true ||
    typeof input.result.next !== "function"
  ) {
    return false;
  }

  return !waitsOnAnything(input.result.session, input.projection);
}

export async function runModelCallBatch(input: {
  readonly steeringSignal?: AbortSignal;
  readonly initialInput: HarnessStepInput | undefined;
  readonly initialSession: HarnessSession;
  readonly modelCallsPerStep: number;
  readonly runStep: (input: {
    readonly firstCall: boolean;
    readonly lastCall: boolean;
    readonly session: HarnessSession;
    readonly stepInput: HarnessStepInput | undefined;
  }) => Promise<StepResult>;
}): Promise<StepResult> {
  let session = input.initialSession;
  let stepInput = input.initialInput;
  let completedModelCalls = 0;

  while (true) {
    const lastCall = completedModelCalls + 1 >= input.modelCallsPerStep;
    const result = await input.runStep({
      firstCall: completedModelCalls === 0,
      lastCall,
      session,
      stepInput,
    });
    completedModelCalls++;
    if (
      !canContinueModelCallBatch({
        lastCall,
        steeringSignal: input.steeringSignal,
        result,
        projection: storedProjection(result.session.state),
      })
    ) {
      return result;
    }
    session = result.session;
    stepInput = undefined;
  }
}
