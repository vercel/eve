import { WORKFLOW_LOCAL_SESSIONS } from "#execution/agent-sessions/steps.js";
import type {
  CoordinationDispatchInput,
  CoordinationDispatchResult,
} from "#execution/coordination-dispatch-shared.js";
import { dispatchCoordinationOn } from "#execution/coordination-dispatch-step.js";
import type { WithSessionStateDelta } from "#execution/session/state-delta.js";
import { startWorkflowToolRun } from "#execution/workflow-host/start-run.js";

const DISPATCH_COORDINATION_MAX_ATTEMPTS = 4;

export async function dispatchCoordinationStep(
  input: CoordinationDispatchInput,
): Promise<WithSessionStateDelta<CoordinationDispatchResult>> {
  "use step";
  return await dispatchCoordinationOn(startWorkflowToolRun, WORKFLOW_LOCAL_SESSIONS, {
    directSendMaxAttempts: DISPATCH_COORDINATION_MAX_ATTEMPTS,
  })(input);
}
dispatchCoordinationStep.maxRetries = DISPATCH_COORDINATION_MAX_ATTEMPTS - 1;
