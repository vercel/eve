import { processApp } from "#runtime/app.js";
import { stopLateAgentSessionStep } from "#execution/agent-sessions/steps.js";
import { recordRemoteChildBinding } from "#execution/child-binding.js";
import {
  applyRunMessagesOn,
  type ApplyRunMessagesInput,
  type ApplyRunMessagesResult,
  type RunMessageChildren,
} from "#execution/tools/workflow/apply-run-messages.js";

const WORKFLOW_CHILDREN: RunMessageChildren = {
  recordRemoteBinding: recordRemoteChildBinding,
  stopLate: stopLateAgentSessionStep,
};

export async function applyRunMessagesStep(
  input: ApplyRunMessagesInput,
): Promise<ApplyRunMessagesResult> {
  "use step";
  return await applyRunMessagesOn(processApp().hosts, WORKFLOW_CHILDREN)(input);
}
