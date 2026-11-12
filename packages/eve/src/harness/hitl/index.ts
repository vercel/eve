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
import { canAskPerson, type Step } from "#harness/step/context.js";
import { park } from "#harness/step/park.js";
import type {
  HarnessSessionBase,
  HarnessToolLookup,
  StepInput,
  StepResult,
} from "#harness/types.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import type { ApprovalAsk, StepCoordinates } from "#harness/session-machine/view.js";
import {
  createTask,
  markPersonWaits,
  readTaskTable,
  writeTaskTable,
} from "#execution/tasks/table.js";
import {
  askApprovals,
  approvalMemory,
  openLimit,
  requestLimit,
  requireSignIn,
  waitAsTasks,
  waitingCalls,
} from "./approvals.js";
import { applyEndingSignIns, stepCallsBack } from "./sign-in-callbacks.js";
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
export {
  endCallerApprovals,
  openDeferredApprovals,
  queueInput,
  withdrawWaitingCalls,
} from "./approvals.js";
export { compactInput, isEmptyInput, turnInputOnly, withoutTurnInput } from "./delivery.js";
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
    /** Who had spoken last as the model made the calls. */
    readonly sender: SessionAuthContext | null;
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
    sender: input.sender,
    tasks: input.tasks,
  });
  await step.apply(transition, [...step.session.history, ...committedMessages(transition)]);
}

/**
 * A message joined the turn: every call still waiting on a person becomes a task. The model reads
 * the message with everything the calls' responses did, each waiting call's receipt among it, and
 * the requests stay open; each call runs once its person acts.
 */
export async function waitOnPeopleAsTasks(step: Step): Promise<void> {
  const calls = waitingCalls(step.view());
  if (calls.length === 0) return;
  let table = readTaskTable(step.session.state);
  const tasks = calls.map((call) => {
    const created = createTask(table, {
      awaitsPerson: true,
      callId: call.callId,
      kind: "tool",
      name: call.toolName,
      resumable: false,
      turnId: call.turnId,
    });
    table = created.table;
    return { ...call, taskId: created.taskId };
  });
  step.session = markPersonWaits(writeTaskTable(step.session, table));
  const transition = waitAsTasks(step.view(), { calls: tasks });
  await step.apply(transition, [...step.session.history, ...committedMessages(transition)]);
}

/**
 * A call the model step ran needs a sign-in: the calls that need it stop and wait in their
 * steps, and run once it completes.
 */
export async function stopForToolSignIn(
  step: Step,
  interrupt: NonNullable<ReturnType<typeof resolveInlineAuthorizationInterrupt>>,
): Promise<StepResult> {
  await applyEndingSignIns(
    step,
    requireSignIn(step.view(), {
      calls: interrupt.calls,
      challenges: interrupt.challenges,
      callsBack: stepCallsBack(step),
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
    canAsk: canAskPerson(step),
    limit: step.config.sessionUsageLimit ?? DEFAULT_SESSION_USAGE_LIMIT,
    session: step.session,
    turnSequence: step.position().sequence,
    usage: step.view().projection.view.usage.total,
    window: step.view().projection.usageWindow,
  });
  if (limit.kind === "within") return undefined;
  if (limit.kind === "ask") {
    step.session = changeHistory(step.session, { extend: messages });
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

/** What a model call needs from the approvals: what their policies remember. */
export function humanInputContext(step: Step): { readonly approvalMemory: ApprovalMemory } {
  return { approvalMemory: approvalMemory(step.view()) };
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
      // Only the person whose identity a call needs approves eve's request for it.
      if (ask.identity !== undefined) return false;
      const approval = tools.get(ask.call.toolName)?.approval;
      return (
        approval !== undefined && typeof approval !== "function" && approval.response !== undefined
      );
    })
    .map((ask) => ask.interactionId);
}

/** The caller whose turn parks a step. */
function currentRequester(step: Step): SessionAuthContext | null {
  return step.ctx.get(AuthKey) ?? step.ctx.get(SessionKey)?.auth.current ?? null;
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
  signInsEnded,
  signInsEndedBy,
  type AnsweredSignIn,
  type OwnCallbacks,
  type ResumeSignIn,
  type SignInCallback,
  type SignInEnding,
} from "./sign-in-callbacks.js";
export { holdsHitlRequests } from "./view.js";
