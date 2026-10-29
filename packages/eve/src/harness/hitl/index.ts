import type { ApprovalMemory } from "#approval/evaluation.js";
import type { ModelMessage } from "ai";

import type { SessionAuthContext } from "#channel/types.js";
import { AuthKey, SessionKey } from "#context/keys.js";
import type { resolveInlineAuthorizationInterrupt } from "#harness/inline-tool-authorization.js";
import { validateHarnessModelMessages } from "#harness/messages.js";
import { fail } from "#harness/session-machine/transitions.js";
import { readTurnState, writeTurnState } from "#harness/session-machine/state.js";
import type { Step } from "#harness/step/context.js";
import { park } from "#harness/step/park.js";
import type {
  HarnessSessionBase,
  HarnessToolLookup,
  StepInput,
  StepResult,
} from "#harness/types.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import type { ApprovalAsk, StepCoordinates } from "#harness/session-machine/view.js";
import { renderPendingApprovalsInstruction } from "./approval-prompt.js";
import {
  askApprovals,
  approvalMemory,
  pendingApprovals,
  openLimit,
  requestLimit,
  requireSignIn,
} from "./approvals.js";
import { checkSessionUsageLimit, DEFAULT_SESSION_USAGE_LIMIT } from "./budget.js";
import { isEmptyInput } from "./delivery.js";

// The session's human-in-the-loop rules, behind the few points where the rest of the harness
// meets them: a delivery's answers and sign-in callbacks before its turn runs
// (`admitHumanInput`, `settleHumanInput`), the work they decided once the turn has the delivery
// (`applyHumanDecisions`), a model step's gated calls and sign-ins, the budget gate before each
// model call, and what the model reads about pending approvals. Outside readers use only the
// read-only requests view exported here. Nothing here pauses the turn; the step's `park` does.

export {
  admitHumanInput,
  applyHumanDecisions,
  settleHumanInput,
  type HumanDecisions,
  type HumanInputIntake,
} from "./intake.js";
export { openDeferredApprovals, queueInput } from "./approvals.js";
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
    event: input.event,
    messages: input.messages,
    requests: input.requests,
    requester: currentRequester(step),
    responseAuthRequiredRequestIds: responsePolicyRequestIds(input.tools, input.requests),
    tasks: input.tasks,
  });
  await step.apply(transition, [...step.session.history, ...(transition.commit ?? [])]);
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
  return park(step);
}

/**
 * The gate before each model call. A spent budget asks whether to continue when someone can
 * answer, and fails the session otherwise. `messages` are the step's: they park with the prompt,
 * so the input that triggered it survives into the turn that resumes.
 */
export async function enforceBudget(
  step: Step,
  messages: readonly ModelMessage[],
): Promise<StepResult | undefined> {
  const limit = checkSessionUsageLimit({
    canAsk: step.emit !== undefined && step.config.capabilities?.requestInput === true,
    limit: step.config.sessionUsageLimit ?? DEFAULT_SESSION_USAGE_LIMIT,
    session: step.session,
    turnSequence: step.position().sequence,
    usage: step.view().projection.view.usage.total,
    window: step.view().projection.usageWindow,
  });
  if (limit.kind === "within") return undefined;
  if (limit.kind === "ask") {
    step.session = { ...step.session, history: validateHarnessModelMessages([...messages]) };
    // The prompt is asked once; a gate that finds it open still waits on it.
    if (openLimit(step.view())?.row.interactionId !== limit.ask.interactionId)
      await step.apply(requestLimit(step.view(), limit.ask), step.session.history);
    // The turn waits on the prompt; the answer resumes it or cancels it.
    return park(step);
  }
  await step.apply(
    fail(step.view(), {
      code: limit.code,
      details: limit.details,
      message: limit.message,
      terminal: true,
    }),
  );
  return { next: { done: true, output: "" }, session: step.session };
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
