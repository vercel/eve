import { transition } from "#harness/session-machine/commit.js";
import { changeHistory } from "#harness/session-machine/history.js";
import type { ApprovalMemory } from "#approval/evaluation.js";
import type { ModelMessage } from "ai";

import type { SessionAuthContext } from "#channel/types.js";
import { AuthKey, SessionKey } from "#context/keys.js";
import type { resolveInlineAuthorizationInterrupt } from "#harness/inline-tool-authorization.js";
import { commitOf, committedMessages, saveTransition } from "#harness/session-machine/commit.js";
import { callSignIns, callSignInsSettled, fail } from "#harness/session-machine/transitions.js";
import { readTurnState } from "#harness/session-machine/state.js";
import { failSignIn, type Step } from "#harness/step/context.js";
import { park } from "#harness/step/park.js";
import { isConnectionAuthorizationFailedError } from "#connections/errors.js";
import {
  handleAuthorizationError,
  isScopedAuthorizationRequiredError,
} from "#runtime/connections/scoped-authorization.js";
import { signInAttemptKey } from "#harness/hitl/sign-ins.js";
import { signInFailureOf } from "./approved-calls.js";
import type {
  HarnessSessionBase,
  HarnessToolLookup,
  StepInput,
  StepResult,
} from "#harness/types.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import type { ApprovalAsk, StepCoordinates } from "#harness/session-machine/view.js";
import {
  askApprovals,
  approvalMemory,
  openLimit,
  requestLimit,
  requireSignIn,
} from "./approvals.js";
import { applyEndingSignIns, stepCallsBack } from "./sign-in-callbacks.js";
import { checkSessionUsageLimit, DEFAULT_SESSION_USAGE_LIMIT } from "./budget.js";
import { isEmptyInput } from "./delivery.js";

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

export async function askStepApprovals(
  step: Step,
  input: {
    readonly event: StepCoordinates;
    readonly messages: readonly ModelMessage[];
    readonly requests: readonly ApprovalAsk[];
    readonly tasks: readonly RuntimeWorkflowTaskRequest[];
    readonly endsTurn?: true;
    readonly tools: HarnessToolLookup;
  },
): Promise<void> {
  const transition = askApprovals(step.view(), {
    endsTurn: input.endsTurn,
    event: input.event,
    messages: input.messages,
    requests: input.requests,
    requester: currentRequester(step),
    responseAuthRequiredRequestIds: responsePolicyRequestIds(input.tools, input.requests),
    tasks: input.tasks,
  });
  await step.apply(transition, [...step.session.history, ...committedMessages(transition)]);
}

type SignInInterrupt = NonNullable<ReturnType<typeof resolveInlineAuthorizationInterrupt>>;

export async function stopForSignIn(
  step: Step,
  signIn: Pick<SignInInterrupt, "challenges"> & Partial<Pick<SignInInterrupt, "calls">>,
): Promise<StepResult> {
  await applyEndingSignIns(
    step,
    requireSignIn(step.view(), {
      calls: signIn.calls,
      challenges: signIn.challenges,
      callsBack: stepCallsBack(step),
    }),
    step.session.history,
  );
  return park(step);
}

export async function pauseForSignIn(step: Step, error: unknown): Promise<StepResult> {
  if (!isScopedAuthorizationRequiredError(error)) {
    return await failSignIn(step, error, {
      scope: isConnectionAuthorizationFailedError(error) ? error.connectionName : "",
    });
  }
  try {
    return await stopForSignIn(step, await handleAuthorizationError(error));
  } catch (refused) {
    return await failSignIn(step, refused, error.scoped);
  }
}

export async function settleModelSignIns(step: Step, failure?: unknown): Promise<boolean> {
  const view = step.view();
  const byCalls = new Set(callSignIns(view.turn).map(signInAttemptKey));
  const signIns = (step.config.signInCompletions ?? []).filter(
    (challenge) => challenge.candidateId === undefined && !byCalls.has(signInAttemptKey(challenge)),
  );
  const events = callSignInsSettled(
    view,
    { signIns },
    failure === undefined ? undefined : signInFailureOf(failure),
  );
  if (events.length === 0) return false;
  await step.apply(commitOf(events));
  return true;
}

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
    step.session = changeHistory(step.session, { extend: messages });
    if (openLimit(step.view())?.row.interactionId !== limit.ask.interactionId)
      await step.apply(requestLimit(step.view(), limit.ask), step.session.history);
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

export function humanInputContext(step: Step): { readonly approvalMemory: ApprovalMemory } {
  return { approvalMemory: approvalMemory(step.view()) };
}

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

function currentRequester(step: Step): SessionAuthContext | null {
  return step.ctx.get(AuthKey) ?? step.ctx.get(SessionKey)?.auth.current ?? null;
}

export function takeDeferredMessage<T extends HarnessSessionBase>(
  session: T,
): { readonly message?: StepInput["message"]; readonly session: T } {
  const { queued, ...turn } = readTurnState(session.state);
  if (queued?.message === undefined) return { session };
  const { message, ...rest } = queued;
  return {
    message,
    session: saveTransition(
      session,
      transition({
        events: [],
        turn: isEmptyInput(rest) ? turn : { ...turn, queued: rest },
      }),
    ),
  };
}

export { readHitlState } from "./requests.js";
export {
  callsBackFor,
  localSignInCallback,
  ownCallbacks,
  ResumeSignInKey,
  settleSignIns,
  signInsAnswered,
  signInsEnded,
  type AnsweredSignIn,
  type OwnCallbacks,
  type ResumeSignIn,
  type SignInAnswer,
  type SignInCallback,
  type SignInEnding,
} from "./sign-in-callbacks.js";
export { holdsHitlRequests } from "./view.js";
