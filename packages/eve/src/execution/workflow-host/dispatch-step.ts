import { WORKFLOW_LOCAL_SESSIONS } from "#execution/agent-sessions/steps.js";
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
  return await dispatchCoordinationOn(startWorkflowToolRun, WORKFLOW_LOCAL_SESSIONS)(input);
}
