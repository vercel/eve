import type { ModelMessage } from "ai";
import type { ApprovalMemory } from "#approval/evaluation.js";

import type { SessionAuthContext } from "#channel/types.js";
import { AuthKey, SessionKey } from "#context/keys.js";
import type { resolveInlineAuthorizationInterrupt } from "#harness/inline-tool-authorization.js";
import { suspendStep } from "#harness/session-machine/transitions.js";
import { readTurnState, writeTurnState } from "#harness/session-machine/state.js";
import type { Step } from "#harness/step/context.js";
import type {
  HarnessSessionBase,
  HarnessToolLookup,
  StepInput,
  StepResult,
} from "#harness/types.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import type { ApprovalAsk, StepCoordinates } from "#harness/session-machine/view.js";
import { renderPendingApprovalsInstruction } from "./approval-prompt.js";
import { askApprovals, approvalMemory, pendingApprovals, requireSignIn } from "./approvals.js";
import { isEmptyInput } from "./delivery.js";

// The session's human-in-the-loop rules, behind the few points where the rest of the harness
// meets them: a delivery's answers and sign-in callbacks before its turn runs
// (`admitHumanInput`, `settleHumanInput`), the work they decided once the turn has the delivery
// (`applyHumanDecisions`), a model step's gated calls and sign-ins, the budget gate before each
// model call, and what the model reads about pending approvals. Outside readers use only the
// read-only requests view exported here. Step decisions derive waiting from the recorded state.

export {
  admitHumanInput,
  applyHumanDecisions,
  settleHumanInput,
  takeAnswers,
  type HumanDecisions,
  type HumanInputIntake,
} from "./intake.js";
export { openDeferredApprovals, queueInput } from "./approvals.js";
export { enforceBudget } from "./budget.js";
export { compactInput, turnInputOnly, withoutTurnInput } from "./delivery.js";
export type { PendingResponder } from "./responders.js";

/**
 * A model step made calls that need a person's approval: the step's response waits on them
 * beside any runtime calls it made, asked as the turn's requester.
 */
export async function askStepApprovals(
  step: Step,
  input: {
    readonly event: StepCoordinates;
    readonly messages: readonly ModelMessage[];
    readonly requests: readonly ApprovalAsk[];
    readonly tasks: readonly RuntimeWorkflowTaskRequest[];
    /** The entries the step's calls ran, whose approvals the requests ask for. */
    readonly tools: HarnessToolLookup;
  },
): Promise<void> {
  const transition = askApprovals(step.view(), {
    ...input,
    requester: currentRequester(step),
    responseAuthRequiredRequestIds: responsePolicyRequestIds(input.tools, input.requests),
  });
  await step.apply(transition, [...step.session.history, ...(transition.commit ?? [])]);
}

/** Holds a model response on the calls eve gated: approvals, a sign-in, or the runtime's work. */
export async function holdStep(
  step: Step,
  input: Parameters<typeof askStepApprovals>[1] & {
    readonly signIn?: NonNullable<ReturnType<typeof resolveInlineAuthorizationInterrupt>>;
  },
): Promise<StepResult> {
  // Catalogs contain callbacks; only continuation data belongs in the saved step.
  const { tools, requests, signIn, ...response } = input;
  if (requests.length > 0) await askStepApprovals(step, { ...response, requests, tools });
  else await step.apply(suspendStep(step.view(), response));
  // Approval precedes sign-in for the same call, not an executing sibling.
  if (signIn !== undefined) return stopForToolSignIn(step, signIn);
  return { session: step.session };
}

/**
 * A call the model step ran needs a sign-in: the calls that need it stop and wait in their
 * steps, and run once it completes.
 */
export async function stopForToolSignIn(
  step: Step,
  interrupt: NonNullable<ReturnType<typeof resolveInlineAuthorizationInterrupt>>,
): Promise<StepResult> {
  await step.apply(
    requireSignIn(step.view(), {
      calls: interrupt.calls,
      challenges: interrupt.challenges,
    }),
    step.session.history,
  );
  return { session: step.session };
}

/**
 * What a model call needs from the approvals: what their policies remember, and
 * a note on the calls still awaiting approval, which a message may revise.
 */
export function humanInputContext(step: Step): {
  readonly approvalMemory: ApprovalMemory;
  readonly pendingApprovalsNote?: string;
} {
  const view = step.view();
  return {
    approvalMemory: approvalMemory(view),
    pendingApprovalsNote: renderPendingApprovalsInstruction(
      view.turn.suspended.flatMap((parked) => pendingApprovals(view, parked)),
    ),
  };
}

/**
 * The approvals whose tool defines a response policy. Every park records them, so no Approve or
 * Cancel of such an approval skips the policy.
 */
function responsePolicyRequestIds(
  tools: HarnessToolLookup,
  requests: readonly ApprovalAsk[],
): readonly string[] {
  return requests
    .filter((ask) => {
      const approval = tools.get(ask.call.toolName)?.approval;
      return (
        approval !== undefined && typeof approval !== "function" && approval.response !== undefined
      );
    })
    .map((ask) => ask.interactionId);
}

/** The caller whose turn parks a step. */
function currentRequester(step: Step): SessionAuthContext | null {
  return step.ctx?.get(AuthKey) ?? step.ctx?.get(SessionKey)?.auth.current ?? null;
}

/**
 * Takes the message a delivery's answers deferred into the turn queue out of it, so a cancelled
 * turn can keep it in history once instead of also leaving it queued. The rest of the queue stays.
 */
export function takeDeferredMessage<T extends HarnessSessionBase>(
  session: T,
): { readonly message?: StepInput["message"]; readonly session: T } {
  const { queued, ...turn } = readTurnState(session.state);
  if (queued?.message === undefined) return { session };
  const { message, ...rest } = queued;
  return {
    message,
    session: writeTurnState(session, isEmptyInput(rest) ? turn : { ...turn, queued: rest }),
  };
}

export { readHitlState } from "./requests.js";
export { holdsHitlRequests } from "./view.js";
