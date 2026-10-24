import { decideStep } from "#execution/session/step-decision.js";
import { readStepState } from "#execution/session/step-reading.js";
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
    if (
      input.steeringSignal?.aborted === true ||
      result.steered === true ||
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

function shouldRunAnotherModelCall(input: {
  readonly completedModelCalls: number;
  readonly modelCallsPerStep: number;
  readonly result: StepResult;
}): boolean {
  if (input.completedModelCalls >= input.modelCallsPerStep) return false;
  return decideStep(readStepState(input.result.session, input.result.unreadInput)).kind === "run";
}
