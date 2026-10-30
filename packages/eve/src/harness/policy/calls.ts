import { asSchema, type ToolSet, type TypedToolCall } from "ai";

import {
  buildStepCatalog,
  recordOfferedCatalogTools,
  type StepCatalog,
} from "#execution/catalog/step-catalog.js";
import { createPresentedRuntimeActionRequestFromToolCall } from "#harness/action-presentation.js";
import { stageToolResultMedia } from "#harness/attachment-staging.js";
import { callRequested } from "#harness/call-facts.js";
import { executeInlineCalls } from "#harness/call-executor.js";
import { humanInputContext } from "#harness/hitl/index.js";
import { changeHistory } from "#harness/session-machine/history.js";
import { collectWorkflowCalls } from "#harness/coordination.js";
import { askStepApprovals, enforceBudget, stopForToolSignIn } from "#harness/hitl/index.js";
import { resolveInlineAuthorizationInterrupt } from "#harness/inline-tool-authorization.js";
import { extractToolResultCallIds } from "#harness/model-call/response.js";
import { suspendStep } from "#harness/session-machine/transitions.js";
import { park } from "#harness/step/park.js";
import type { HarnessStepResult } from "#harness/step-hooks.js";
import { isWorkflowTool } from "#execution/tasks/model-step.js";
import type { ModelMessage } from "ai";
import type { Step } from "#harness/step/context.js";
import { throwIfTurnAborted } from "#harness/turn-cancellation.js";
import type { StepResult } from "#harness/types.js";
import { createLogger } from "#internal/logging.js";
import { toModelSchema } from "#tools/schema.js";
import { failPolicy, invalid } from "./failure.js";
import type { Next } from "./policy.js";

const log = createLogger("harness.program");

export type PolicyCalls = Extract<Next, { calls: unknown }>["calls"];

/**
 * Runs a policy's calls as the agent's own: each is requested under the turn, validated against
 * its tool's input schema, and goes through the gate a model's call goes through. Calls that wait
 * park the step; otherwise they join history after `promptMessages`, and the policy decides again.
 */
export async function runPolicyCalls(step: Step, calls: PolicyCalls): Promise<StepResult> {
  if (!Array.isArray(calls) || calls.length === 0) return await invalid(step, "returned no calls");
  // Calls spend as a model call would: the session's usage limit stands before them too.
  const overBudget = await enforceBudget(step, step.session.history);
  if (overBudget !== undefined) return overBudget;
  // The step's dynamic values were evaluated before the decision, so its tools are current.
  const catalog = buildStepCatalog({
    agentTools: step.config.tools,
    ctx: step.ctx,
    endsTurn: false,
    session: step.session,
  });
  recordOfferedCatalogTools(step.ctx, catalog);
  const turnId = step.position().turnId;
  const view = step.view().projection.view;
  const made = Object.values(view.calls).filter(
    (row) => "turnId" in row.owner && row.owner.turnId === turnId,
  ).length;
  const toolCalls: TypedToolCall<ToolSet>[] = [];
  for (const [index, call] of calls.entries()) {
    const definition = catalog.get(call.tool);
    if (definition === undefined)
      return await invalid(step, `called "${call.tool}", which isn't a tool here`);
    const checked = await asSchema(toModelSchema(definition.inputSchema, "input")).validate?.(
      call.input ?? {},
    );
    if (checked?.success === false) {
      log.error("the harness policy called a tool with input its schema rejects", {
        error: checked.error,
        tool: call.tool,
        turnId,
      });
      return await failPolicy(step);
    }
    toolCalls.push({
      input: checked === undefined ? (call.input ?? {}) : checked.value,
      toolCallId: `call_${turnId.replace(/[^\w-]/g, "_")}_${made + index}`,
      toolName: call.tool,
      type: "tool-call",
    } as TypedToolCall<ToolSet>);
  }
  await step.apply(
    toolCalls.map((toolCall) => {
      const { action, presentationLabel } = createPresentedRuntimeActionRequestFromToolCall({
        toolCall,
        tools: catalog,
      });
      return callRequested({ action, label: presentationLabel, owner: { turnId } });
    }),
  );
  const results = await executeInlineCalls({
    abortSignal: step.config.abortSignal,
    approvalMemory: humanInputContext(step).approvalMemory,
    beforeExecute: () => {},
    excludedCallIds: new Set(),
    messages: [...step.session.history],
    publish: step.publish,
    toolCalls,
    tools: catalog,
  });
  throwIfTurnAborted(step.config.abortSignal);
  const messages = await stageToolResultMedia([
    {
      content: toolCalls.map(({ input, toolCallId, toolName }) => ({
        input,
        toolCallId,
        toolName,
        type: "tool-call" as const,
      })),
      role: "assistant",
    },
    ...(results.parts.length === 0 ? [] : [{ content: [...results.parts], role: "tool" as const }]),
  ]);
  const parked = await parkCalls(step, {
    approvals: results.approvals,
    catalog,
    messages,
    policyApprovals: results.policyApprovals,
    promptMessages: step.session.history,
    signIns: results.signIns,
    toolCalls,
  });
  if (parked !== undefined) return parked;
  step.session = changeHistory(step.session, { append: messages });
  return { next: step.runStep, session: step.session };
}

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
