import type { ModelMessage } from "ai";

import type { SessionAuthContext } from "#channel/types.js";
import { AuthKey, SessionKey } from "#context/keys.js";
import { clearPendingAuthorization } from "#harness/authorization.js";
import type { resolveInlineAuthorizationInterrupt } from "#harness/inline-tool-authorization.js";
import { validateHarnessModelMessages } from "#harness/messages.js";
import { fail } from "#harness/session-machine/transitions.js";
import { readTurnState, writeTurnState } from "#harness/session-machine/state.js";
import type { StepCoordinates } from "#harness/session-machine/view.js";
import type { Step } from "#harness/step/context.js";
import type {
  HarnessSessionBase,
  HarnessToolLookup,
  StepInput,
  StepResult,
} from "#harness/types.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import type { InputRequest } from "#shared/input.js";
import { renderPendingApprovalsInstruction } from "./approval-prompt.js";
import {
  grantedApprovalKeys,
  hasRunnableQueue,
  parkOnApprovals as parkOnApprovalsTransition,
  requestLimit,
  requireSignIn,
} from "./approvals.js";
import { checkSessionUsageLimit } from "./budget.js";
import { retireActiveCandidates } from "./candidates.js";
import { isEmptyInput } from "./delivery.js";
import { holdForInput } from "./intake.js";

// The session's human-in-the-loop lifecycle, behind the few points where the rest of the harness
// meets it: a delivery's answers and sign-in callbacks before its turn runs (`acceptHumanInput`),
// the work they approved once its model step starts (`runApprovedLocalCalls`), a model step's gated calls and
// sign-ins, the budget gate before each model call, and what the model reads about pending
// approvals. Nothing outside this directory reads its records.

export {
  acceptHumanInput,
  admitApprovedWork,
  dispatchApprovedWorkflows,
  hasApprovedWork,
  runApprovedLocalCalls,
  type ApprovedWork,
  type HumanInputIntake,
} from "./intake.js";
export { hasRunnableQueue } from "./approvals.js";

/**
 * A model step made calls that need a person's approval: the step parks on them beside any
 * runtime calls it made. The turn holds for the answers, unless the runtime runs calls for it
 * meanwhile, or queued input can already run.
 */
export async function parkOnApprovals(
  step: Step,
  input: {
    readonly event: StepCoordinates;
    readonly messages: readonly ModelMessage[];
    readonly requests: readonly InputRequest[];
    readonly tasks: readonly RuntimeWorkflowTaskRequest[];
    /** The entries the step's calls ran, whose approvals the requests ask for. */
    readonly tools: HarnessToolLookup;
    /** The step made calls the runtime runs, so the turn waits on them instead. */
    readonly waitsOnRuntime: boolean;
  },
): Promise<StepResult> {
  const transition = parkOnApprovalsTransition(step.view(), {
    event: input.event,
    messages: input.messages,
    requests: input.requests,
    tasks: input.tasks,
    requester: currentRequester(step),
    responseAuthRequiredRequestIds: responsePolicyRequestIds(input.tools, input.requests),
  });
  await step.apply(transition, [...step.session.history, ...(transition.commit ?? [])]);
  if (input.waitsOnRuntime) return { next: null, session: step.session };
  if (hasRunnableQueue(step.view())) return { next: step.runStep, session: step.session };
  return holdForInput(step);
}

/**
 * A call the model step ran needs a sign-in: the calls that need it stop, and the model calls
 * them again once it completes.
 */
export async function stopForToolSignIn(
  step: Step,
  interrupt: NonNullable<ReturnType<typeof resolveInlineAuthorizationInterrupt>>,
): Promise<StepResult> {
  step.session = { ...step.session, history: validateHarnessModelMessages(interrupt.history) };
  await step.apply(
    requireSignIn(step.view(), {
      callIdsByName: interrupt.callIdsByName,
      challenges: interrupt.challenges,
    }),
    step.session.history,
  );
  return { held: { kind: "request" }, next: null, session: step.session };
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
    session: step.session,
    turnSequence: step.position().sequence,
  });
  if (limit.kind === "within") return undefined;
  if (limit.kind === "ask") {
    step.session = { ...step.session, history: validateHarnessModelMessages([...messages]) };
    await step.apply(requestLimit(step.view(), { request: limit.request }), step.session.history);
    return { next: null, session: step.session };
  }
  await step.apply(
    fail(step.view(), {
      code: limit.code,
      details: limit.details,
      message: limit.message,
      terminal: { sessionId: step.session.sessionId },
    }),
  );
  return { next: { done: true, output: "" }, session: step.session };
}

/**
 * What a model call needs from the approvals: the keys `once()` approvals of `tools` granted, and
 * a note on the calls still awaiting approval, which a message may revise.
 */
export function humanInputContext(
  step: Step,
  tools: HarnessToolLookup,
): {
  readonly approvedTools: ReadonlySet<string>;
  readonly pendingApprovalsNote?: string;
} {
  const view = step.view();
  return {
    approvedTools: grantedApprovalKeys(view, (request) =>
      tools.get(request.action.toolName)?.approvalKey?.(request.action.input),
    ),
    pendingApprovalsNote: renderPendingApprovalsInstruction(
      view.turn.suspended.flatMap((parked) => parked.requests),
    ),
  };
}

const APPROVAL_STATE_KEY = "eve.runtime.hitl.approvalState";

/**
 * Drops what a cleared context owned: sign-in attempts and responders' approval progress. `clear`
 * reported each close; relay routes for live tasks stay.
 */
export function discardClearedHumanInput<T extends HarnessSessionBase>(session: T): T {
  const { [APPROVAL_STATE_KEY]: _approvals, ...state } =
    clearPendingAuthorization(session.state) ?? {};
  return { ...session, state: Object.keys(state).length > 0 ? state : undefined };
}

/**
 * The approvals whose tool defines a response policy. Every park records them, so no Approve or
 * Cancel of such an approval skips the policy.
 */
function responsePolicyRequestIds(
  tools: HarnessToolLookup,
  requests: readonly InputRequest[],
): readonly string[] {
  return requests
    .filter((request) => {
      const approval = tools.get(request.action.toolName)?.approval;
      return (
        approval !== undefined && typeof approval !== "function" && approval.response !== undefined
      );
    })
    .map((request) => request.requestId);
}

/** The caller whose turn parks a step. */
function currentRequester(step: Step): SessionAuthContext | null {
  return step.ctx?.get(AuthKey) ?? step.ctx?.get(SessionKey)?.auth.current ?? null;
}

/** The cancelled turn's responders stop checking its approvals: their candidates stale. */
export function retireCancelledCandidates<T extends HarnessSessionBase>(session: T): T {
  return {
    ...session,
    state: retireActiveCandidates(session.state, { completedAt: Date.now(), reason: "Cancelled." }),
  };
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
