import type {
  CoordinationDispatchInput,
  CoordinationDispatchResult,
} from "#execution/coordination-dispatch-shared.js";
import { dispatchCoordinationOn } from "#execution/coordination-dispatch-step.js";
import type { WithSessionStateDelta } from "#execution/session/state-delta.js";
import { startWorkflowToolRun } from "#execution/workflow-host/start-run.js";

export async function dispatchCoordinationStep(
  input: CoordinationDispatchInput,
): Promise<WithSessionStateDelta<CoordinationDispatchResult>> {
  "use step";
  return await dispatchCoordinationOn(startWorkflowToolRun)(input);
}
