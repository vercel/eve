import type {
  CoordinationDispatchInput,
  CoordinationDispatchResult,
} from "#execution/coordination-dispatch-shared.js";
import { dispatchCoordinationOn } from "#execution/coordination-dispatch-step.js";
import type { WithSessionStateDelta } from "#execution/session/state-delta.js";
import { startWorkflowToolRun } from "#execution/workflow-host/start-run.js";

/**
 * Starts the runs of the pending calls and records them on the session. A
 * retry starts its runs again, since a Workflow start has no idempotency key,
 * so this step publishes nothing and commits as soon as the runs are
 * recorded. See `publishDispatchedCallsStep`.
 */
export async function dispatchCoordinationStep(
  input: CoordinationDispatchInput,
): Promise<WithSessionStateDelta<CoordinationDispatchResult>> {
  "use step";
  return await dispatchCoordinationOn(startWorkflowToolRun)(input);
}
