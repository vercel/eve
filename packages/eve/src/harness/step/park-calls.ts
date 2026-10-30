import type { ModelMessage, ToolSet, TypedToolCall } from "ai";
import type { StepCatalog } from "#execution/catalog/step-catalog.js";
import { isWorkflowTool } from "#execution/tasks/model-step.js";
import { collectWorkflowCalls } from "#harness/coordination.js";
import { askStepApprovals, stopForToolSignIn } from "#harness/hitl/index.js";
import { resolveInlineAuthorizationInterrupt } from "#harness/inline-tool-authorization.js";
import { extractToolResultCallIds } from "#harness/model-call/response.js";
import { changeHistory } from "#harness/session-machine/history.js";
import { suspendStep } from "#harness/session-machine/transitions.js";
import type { HarnessStepResult } from "#harness/step-hooks.js";
import type { Step } from "./context.js";
import { park } from "./park.js";
import type { StepResult } from "#harness/types.js";

/**
 * Parks a batch of calls that wait: on a person's approval, a sign-in, or the runtime running a
 * workflow or task tool. The batch's messages wait with the step and commit once every call has a
 * result. `undefined` when nothing waits. A model response's calls and a policy's both park here.
 */
export async function parkCalls(
  step: Step,
  input: {
    readonly toolCalls: readonly TypedToolCall<ToolSet>[];
    readonly approvals: NonNullable<HarnessStepResult["approvalRequests"]>;
    readonly signIns: NonNullable<HarnessStepResult["signIns"]>;
    readonly policyApprovals?: HarnessStepResult["policyApprovals"];
    readonly invalidCallIds?: ReadonlySet<string>;
    readonly catalog: StepCatalog;
    /** The prompt that commits with the batch. */
    readonly promptMessages: readonly ModelMessage[];
    /** The batch's call and result messages. */
    readonly messages: readonly ModelMessage[];
  },
): Promise<StepResult | undefined> {
  const { approvals, catalog } = input;
  // Only unanswered calls can dispatch: automatic denials already have results.
  const blockedCallIds = new Set([
    ...approvals.map((ask) => ask.call.callId),
    ...extractToolResultCallIds(input.messages),
  ]);
  const workflowToolCalls = input.toolCalls
    .filter((toolCall) => input.invalidCallIds?.has(toolCall.toolCallId) !== true)
    .filter((toolCall) => !blockedCallIds.has(toolCall.toolCallId))
    .filter((toolCall) => isWorkflowTool(catalog.get(toolCall.toolName)));
  const authorizationInterrupt = resolveInlineAuthorizationInterrupt({ signIns: input.signIns });
  if (workflowToolCalls.length === 0 && approvals.length === 0 && !authorizationInterrupt) {
    return undefined;
  }
  const { sequence, stepIndex, turnId } = step.position();
  const dispatched = collectWorkflowCalls({
    session: step.session,
    toolCalls: workflowToolCalls,
    tools: catalog,
    turnId,
  });
  step.session = changeHistory(dispatched.session, { extend: input.promptMessages });
  const parked = {
    event: { sequence, stepIndex, turnId },
    messages: [...input.messages],
    tasks: dispatched.workflowRequests.map((task) => ({
      ...task,
      clearedBy: input.policyApprovals?.[task.callId],
    })),
  };
  if (approvals.length > 0) {
    await askStepApprovals(step, { ...parked, requests: approvals, tools: catalog });
  } else {
    await step.apply(suspendStep(step.view(), parked));
  }
  // Approval only precedes sign-in for the same call, not an executing sibling.
  if (authorizationInterrupt) return stopForToolSignIn(step, authorizationInterrupt);
  return park(step);
}
