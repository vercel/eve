import { stopLateAgentSessionStep } from "#execution/agent-sessions/steps.js";
import { recordRemoteChildBinding } from "#execution/child-binding.js";
import {
  applyRunMessagesOn,
  type ApplyRunMessagesInput,
  type ApplyRunMessagesResult,
  type RunMessageChildren,
} from "#execution/tools/workflow/apply-run-messages.js";

/** A session's children on Workflow: a late one is stopped in a step, a remote one's binding rides the parent's run. */
const WORKFLOW_CHILDREN: RunMessageChildren = {
  recordRemoteBinding: recordRemoteChildBinding,
  stopLate: stopLateAgentSessionStep,
};

/** Applies run messages to the session in one durable step. */
export async function applyRunMessagesStep(
  input: ApplyRunMessagesInput,
): Promise<ApplyRunMessagesResult> {
  "use step";
  return await applyRunMessagesOn(WORKFLOW_CHILDREN)(input);
}
