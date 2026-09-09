import { derivePendingState } from "#execution/pending-turn-state.js";
import { getPendingWorkflowInterrupt } from "#harness/workflow-interrupt-state.js";
import type { HarnessSession, StepInput, StepResult } from "#harness/types.js";

export async function runModelCallBatch(input: {
  readonly initialInput: StepInput | undefined;
  readonly initialSession: HarnessSession;
  readonly maxModelCallsPerWorkflowStep: number;
  readonly runStep: (input: {
    readonly firstCall: boolean;
    readonly session: HarnessSession;
    readonly stepInput: StepInput | undefined;
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
      !shouldRunAnotherModelCall({
        completedModelCalls,
        maxModelCallsPerWorkflowStep: input.maxModelCallsPerWorkflowStep,
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
  readonly maxModelCallsPerWorkflowStep: number;
  readonly result: StepResult;
}): boolean {
  if (
    input.completedModelCalls >= input.maxModelCallsPerWorkflowStep ||
    typeof input.result.next !== "function" ||
    input.result.backgroundTaskSession !== undefined ||
    input.result.backgroundTasks !== undefined ||
    getPendingWorkflowInterrupt(input.result.session.state) !== undefined
  ) {
    return false;
  }

  const pending = derivePendingState(input.result.session);
  return (
    !pending.hasPendingAuthorization &&
    !pending.hasPendingInputBatch &&
    (pending.pendingCoordinationCallIds?.length ?? 0) === 0
  );
}
