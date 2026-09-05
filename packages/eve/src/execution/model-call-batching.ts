import { derivePendingState } from "#execution/pending-turn-state.js";
import { getPendingWorkflowInterrupt } from "#harness/workflow-interrupt-state.js";
import type { StepResult } from "#harness/types.js";

export function shouldRunAnotherModelCall(input: {
  readonly completedModelCalls: number;
  readonly maxModelCallsPerWorkflowStep: number;
  readonly result: StepResult;
}): boolean {
  if (
    input.completedModelCalls >= input.maxModelCallsPerWorkflowStep ||
    typeof input.result.next !== "function" ||
    (input.result.backgroundTasks?.length ?? 0) > 0 ||
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
