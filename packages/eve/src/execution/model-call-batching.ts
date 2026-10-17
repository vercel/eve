import { decideStep, readStepState } from "#execution/session/step-decision.js";
import type { HarnessSession, HarnessStepInput, StepResult } from "#harness/types.js";

export async function runModelCallBatch(input: {
  readonly steeringSignal?: AbortSignal;
  readonly initialInput: HarnessStepInput | undefined;
  readonly initialSession: HarnessSession;
  readonly modelCallsPerStep: number;
  readonly runStep: (input: {
    readonly firstCall: boolean;
    readonly session: HarnessSession;
    readonly stepInput: HarnessStepInput | undefined;
  }) => Promise<StepResult>;
}): Promise<StepResult> {
  let session = input.initialSession;
  let stepInput = input.initialInput;
  let completedModelCalls = 0;

  while (true) {
    const result = await input.runStep({
      firstCall: completedModelCalls === 0,
      session,
      stepInput,
    });
    completedModelCalls++;
    // A steered result leaves the signal aborted until the turn takes the steering message.
    if (
      input.steeringSignal?.aborted === true ||
      !shouldRunAnotherModelCall({
        completedModelCalls,
        modelCallsPerStep: input.modelCallsPerStep,
        result,
      })
    ) {
      return result;
    }
    session = result.session;
    stepInput = undefined;
  }
}

/** Another model call joins the batch when the session would run the turn again at once. */
function shouldRunAnotherModelCall(input: {
  readonly completedModelCalls: number;
  readonly modelCallsPerStep: number;
  readonly result: StepResult;
}): boolean {
  if (input.completedModelCalls >= input.modelCallsPerStep) return false;
  // Each step saves the lifecycle it published with its result.
  return decideStep(readStepState(input.result.session)).kind === "run";
}
