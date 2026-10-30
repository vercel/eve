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
import { runtimeWait, type SessionView, ownOpenRequestIds } from "#harness/session-machine/view.js";
import type { HarnessStepInput, StepResult } from "#harness/types.js";
import { readClientContext } from "#internal/client-context.js";
import type { Step } from "./context.js";

// Where a step stops when nothing it holds can run. Every rule a step runs only changes the
// session; none decides that the turn waits. This does, once, from what is still open: a person
// to answer or sign in, or calls the runtime runs. A turn waiting on a person says so.

/**
 * Interaction kinds a message can't steer past: it waits, unreceived, until the person answers.
 * Every other kind gives way to the person's message.
 */
const ANSWER_FIRST_KINDS: ReadonlySet<string> = new Set(["budget"]);

/**
 * Whether the session resumes the turn on a person itself: a request it asked, or its own sign-in.
 * A child's relayed sign-in resumes the turn on its call instead, though readers see a person.
 */
export function resumesOnPerson(view: SessionView): boolean {
  return ownOpenRequestIds(view).size > 0 || view.signIns.length > 0;
}

/** Whether an open request takes its answer before any message: the message waits behind it. */
export function holdsMessages(view: SessionView): boolean {
  const tables = view.projection.view;
  return [...ownOpenRequestIds(view)].some((interactionId) =>
    ANSWER_FIRST_KINDS.has(tables.interactions[interactionId]?.request.kind ?? ""),
  );
}

/** Whether the turn holds input it hasn't taken. */
export function hasQueuedTurnInput(view: SessionView): boolean {
  const queued: HarnessStepInput | undefined = view.turn.queued;
  return (
    queued !== undefined &&
    (queued.message !== undefined ||
      (queued.context?.length ?? 0) > 0 ||
      queued.outputSchema !== undefined ||
      readClientContext(queued) !== undefined ||
      (queued.runtimeActionResults?.length ?? 0) > 0)
  );
}

/** Whether anything open stops the turn from calling the model. */
export function blocked(view: SessionView, state: Step["session"]["state"]): boolean {
  return resumesOnPerson(view) || runtimeWait(state) !== undefined;
}

/**
 * Nothing the step holds can run. Input the turn holds runs next step, past whatever it steers;
 * otherwise the turn stops, waiting on the person it asked or on the runtime's calls.
 */
export function park(step: Step): StepResult {
  const view = step.view();
  if (hasQueuedTurnInput(view) && !holdsMessages(view)) {
    return { next: step.runStep, session: step.session };
  }
  if (resumesOnPerson(view))
    return { held: { kind: "request" }, next: null, session: step.session };
  return { next: null, session: step.session };
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
