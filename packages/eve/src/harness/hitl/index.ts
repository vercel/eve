import { transition } from "#harness/session-machine/commit.js";
import { changeHistory } from "#harness/session-machine/history.js";
import type { ApprovalMemory } from "#approval/evaluation.js";
import type { ModelMessage } from "ai";

import type { SessionAuthContext } from "#channel/types.js";
import { AuthKey, SessionKey } from "#context/keys.js";
import type { resolveInlineAuthorizationInterrupt } from "#harness/inline-tool-authorization.js";
import { committedMessages, saveTransition } from "#harness/session-machine/commit.js";
import { fail } from "#harness/session-machine/transitions.js";
import { readTurnState } from "#harness/session-machine/state.js";
import { failTurn, type Step } from "#harness/step/context.js";
import { park } from "#harness/step/park.js";
import { isConnectionAuthorizationFailedError } from "#connections/errors.js";
import { type ModelCredentialFailureCode, rejectsCredential } from "#harness/model-call/errors.js";
import {
  handleAuthorizationError,
  type ScopedAuthorization,
  type ScopedAuthorizationRequiredError,
} from "#runtime/connections/scoped-authorization.js";
import { SIGN_IN_DECLINED } from "#harness/hitl/sign-ins.js";
import { displayProperName } from "#protocol/session-projection/display-name.js";
import type { SessionView } from "#harness/session-machine/view.js";
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
export { signInReports } from "./approved-calls.js";
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

export async function pauseForModelSignIn(
  step: Step,
  required: ScopedAuthorizationRequiredError,
  beforePause?: () => Promise<void>,
): Promise<StepResult> {
  let signIn: Awaited<ReturnType<typeof handleAuthorizationError>>;
  try {
    signIn = await handleAuthorizationError(required, { evictToken: false });
  } catch (refused) {
    const asked = isConnectionAuthorizationFailedError(refused) || refused === required.cause;
    const code = asked ? "MODEL_AUTHORIZATION_FAILED" : "MODEL_CREDENTIAL_FAILED";
    return await failModelCredential(step, code, refused, required.scoped);
  }
  await beforePause?.();
  return await stopForSignIn(step, signIn);
}

export async function failModelCredential(
  step: Step,
  code: ModelCredentialFailureCode,
  error: unknown,
  scoped: ScopedAuthorization,
): Promise<StepResult> {
  const name = providerName(step.view(), scoped);
  return await failTurn(step, error, code, credentialFailureMessage(code, name, error));
}

function credentialFailureMessage(
  code: ModelCredentialFailureCode,
  name: string,
  error: unknown,
): string {
  switch (code) {
    case "MODEL_AUTHORIZATION_FAILED":
      return signInFailureMessage(name, error);
    case "MODEL_CREATE_FAILED":
      return `eve couldn't build the model from the ${name} credential.`;
    case "MODEL_CREDENTIAL_FAILED":
      return `eve couldn't get the ${name} credential.`;
  }
}

function signInFailureMessage(name: string, error: unknown): string {
  if (!isConnectionAuthorizationFailedError(error)) {
    return rejectsCredential(error)
      ? `${name} rejected the credential.`
      : `The turn got no ${name} credential.`;
  }
  switch (error.reason) {
    case SIGN_IN_DECLINED:
    case "sign_in_cancelled":
      return `The ${name} sign-in ended without a credential.`;
    case "sign_in_unavailable":
      return `A scheduled turn can't ask for the ${name} sign-in.`;
    case "principal_required":
      return `The ${name} credential needs a signed-in user.`;
    case "token_rejected_after_authorization":
      return `${name} rejected the credential from the sign-in.`;
    case "app_not_installed":
    case "authorization_callback_unavailable":
      return `The turn got no ${name} credential.`;
    default:
      return `${name}: ${error.message}`;
  }
}

function providerName(view: SessionView, signIn: ScopedAuthorization): string {
  const cards = Object.values(view.projection.view.interactions).flatMap(
    (row) => row.request.signIn ?? [],
  );
  const card = cards.findLast((asked) => asked.name === signIn.scope);
  return signIn.authorization.displayName ?? card?.displayName ?? displayProperName(signIn.scope);
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
