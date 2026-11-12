import type { ModelMessage, ToolSet, TypedToolCall } from "ai";

import type { Clearance } from "#harness/clearance.js";
import { collectWorkflowCalls } from "#harness/coordination.js";
import type { resolveInlineAuthorizationInterrupt } from "#harness/inline-tool-authorization.js";
import { askStepApprovals, stopForToolSignIn } from "#harness/hitl/index.js";
import type { HarnessStepResult } from "#harness/step-hooks.js";
import { changeHistory } from "#harness/session-machine/history.js";
import { suspendStep } from "#harness/session-machine/transitions.js";
import type { HarnessToolLookup, StepResult } from "#harness/types.js";
import { park } from "./park.js";
import type { Step } from "./context.js";

/**
 * Parks the calls a step made, whoever made them (the model's response, or a harness): workflow
 * and task tools start once the step suspends, approvals wait on people, and a sign-in stops the
 * calls it needs. `undefined` when nothing waits, so the calls' results join history now.
 */
export async function parkCalls(
  step: Step,
  input: {
    readonly workflowToolCalls: readonly TypedToolCall<ToolSet>[];
    readonly approvalRequests: NonNullable<HarnessStepResult["approvalRequests"]>;
    readonly authorizationInterrupt: ReturnType<typeof resolveInlineAuthorizationInterrupt>;
    readonly policyApprovals?: Readonly<Record<string, Clearance>>;
    readonly catalog: HarnessToolLookup;
    /** The step's prompt, which history extends to before the suspended step. */
    readonly promptMessages: readonly ModelMessage[];
    /** The calls and the results they already have, as the suspended step commits them. */
    readonly messages: () => ModelMessage[];
  },
): Promise<StepResult | undefined> {
  const { approvalRequests, authorizationInterrupt, workflowToolCalls } = input;
  if (workflowToolCalls.length === 0 && approvalRequests.length === 0 && !authorizationInterrupt) {
    return undefined;
  }
  const { sequence, stepIndex, turnId } = step.position();
  const dispatched = collectWorkflowCalls({
    clearances: input.policyApprovals ?? {},
    session: step.session,
    toolCalls: workflowToolCalls,
    tools: input.catalog,
    turnId,
  });
  step.session = changeHistory(dispatched.session, { extend: input.promptMessages });
  const parked = {
    event: { sequence, stepIndex, turnId },
    messages: input.messages(),
    tasks: dispatched.workflowRequests,
  };
  if (approvalRequests.length > 0) {
    await askStepApprovals(step, { ...parked, requests: approvalRequests, tools: input.catalog });
  } else {
    await step.apply(suspendStep(step.view(), parked));
  }
  // Approval only precedes sign-in for the same call, not an executing sibling.
  if (authorizationInterrupt) return stopForToolSignIn(step, authorizationInterrupt);
  return park(step);
}
