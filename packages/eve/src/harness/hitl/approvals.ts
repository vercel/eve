import type { SessionEvent } from "#protocol/session-event.js";
import type { ModelMessage } from "ai";

import type { getApprovalAuditState } from "#harness/hitl/candidates.js";
import type { AuthorizationChallenge } from "#harness/authorization.js";
import type { StoppedCall } from "#harness/inline-tool-authorization.js";
import { signInAttemptKey, supersededChallenges, withSignIns } from "./sign-ins.js";
import { renderPendingApprovalsSnippet } from "#harness/hitl/approval-prompt.js";
import {
  failedCall,
  resolveApprovalOutcome,
  TOOL_EXECUTION_DENIED_MESSAGE,
  unavailableToolMessage,
} from "#harness/approval-outcome.js";
import { coalesceTurnInputs, createFrameworkUserMessage } from "#harness/messages.js";
import { limitDecision, type LimitAsk } from "#harness/hitl/budget-request.js";
import type { HarnessStepInput } from "#harness/types.js";
import { readClientContext } from "#internal/client-context.js";
import { callSettledFrom } from "#harness/call-facts.js";
import {
  approvalOpened,
  interactionOpened,
  interactionSettled,
  responseAdmitted,
  responseSettled,
  responseSubmitted,
  signInInteractionId,
  signInOpened,
} from "#harness/interaction-facts.js";
import { responseBindingFor } from "#harness/response-bindings.js";
import { publicViewOf } from "#protocol/session-projection.js";
import { interactionOwner } from "#protocol/session-projection/selectors.js";
import type { RefusedResponse } from "#harness/hitl/coordinator.js";
import { turnCoordinates, turnCoordinatesOf } from "#protocol/session-projection.js";
import { openRequests, SUPERSEDED_BY_MESSAGE } from "#protocol/session-reader.js";
import type { InteractionOutcome } from "#protocol/session-events/families/interaction.js";
import type {
  ResponseOutcome,
  ResponseSubmittedData,
} from "#protocol/session-events/families/response.js";
import type {
  InteractionRow,
  SessionView as PublicView,
} from "#protocol/session-projection/tables.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import type { Answer } from "#shared/input.js";
import type { Transition } from "#harness/session-machine/commit.js";
import {
  canonicalize,
  compactInput,
  isEmptyInput,
  resolveTextInput,
  withoutResponses,
  type ResolvedStepInput,
} from "./delivery.js";
import type {
  ApprovalAsk,
  StepCoordinates,
  SuspendedStep,
  TurnState,
} from "#harness/session-machine/view.js";
import {
  awaitSignIns,
  ownOpenRequestIds,
  runnableCalls,
  settle,
  stepCallIds,
  withoutApproved,
  suspend,
  withResult,
} from "#harness/session-machine/transitions.js";
import { turnPosition, type SessionView } from "#harness/session-machine/view.js";

// The session's human-in-the-loop transitions. A model step parks on the approvals its calls
// need (`parkOnApprovals`), a delivery answers them (`answer`), an exhausted budget asks to continue
// (`requestLimit`), and a sign-in stops the calls that need it (`requireSignIn`). Approvals and
// sign-ins hold their turn open; the rest of the machine sees only calls with and without results.

// ---------------------------------------------------------------------------
// parkOnApprovals
// ---------------------------------------------------------------------------

/**
 * A model response made calls that need a person's approval. The response waits in a suspended
 * step, beside any runtime calls it made, and the turn holds until the answers arrive.
 */
export function parkOnApprovals(
  view: SessionView,
  input: {
    readonly event: StepCoordinates;
    readonly messages: readonly ModelMessage[];
    readonly requests: readonly ApprovalAsk[];
    readonly tasks: readonly RuntimeWorkflowTaskRequest[];
    readonly responseAuthRequiredRequestIds?: readonly string[];
    readonly requester?: SuspendedStep["requester"];
  },
): Transition {
  // Every anonymous caller shares one synthetic identity, so an anonymous requester can't be told
  // apart from another anonymous responder: record none.
  const requester = input.requester?.principalType === "anonymous" ? null : input.requester;
  // Results of work resumed in this step stay ahead of the notice; the rest waits for approval.
  const pendingStart = input.messages.findIndex((message) => message.role !== "tool");
  const committed = pendingStart === -1 ? input.messages : input.messages.slice(0, pendingStart);
  const snippet = renderPendingApprovalsSnippet(input.requests);
  const turn = suspend(view.turn, {
    event: input.event,
    messages: input.messages.slice(committed.length),
    requester,
    requests: input.requests,
    responseAuthRequiredRequestIds: input.responseAuthRequiredRequestIds,
    tasks: input.tasks,
  });
  return {
    commit: [
      ...committed,
      ...(snippet === undefined ? [] : [createFrameworkUserMessage("context.state", snippet)]),
    ],
    // The approvals can't settle before the step's tasks finish, so asking for them waits until
    // then; `settle` asks once they have.
    events:
      input.tasks.length > 0
        ? []
        : input.requests.map((ask) => approvalOpened(ask, input.event.turnId)),
    turn,
  };
}

/** Approved workflow and agent calls join the runs their requesting steps wait on. */
export function dispatch(
  view: SessionView,
  input: {
    readonly tasks: readonly RuntimeWorkflowTaskRequest[];
  },
): Transition {
  const suspended = view.turn.suspended.map((step) => {
    const calls = stepCallIds(step);
    const tasks = input.tasks.filter((task) => calls.has(task.callId));
    if (tasks.length === 0) return step;
    const dispatched = withoutApproved(step, new Set(tasks.map((task) => task.callId)));
    return {
      ...dispatched,
      tasks: [...step.tasks, ...tasks],
    };
  });
  return { events: [], turn: { ...view.turn, suspended } };
}

/**
 * Approved calls run before the delivery's own input, as the AI SDK ran them: the model reads
 * their results first. The input waits in the queue, unreceived, for the step after.
 */
export function deferInput(view: SessionView, input: HarnessStepInput): Transition {
  return { events: [], turn: withQueued(view.turn, input) };
}

/** `input` without the answers whose responses already settled. */
function withoutSettledAnswers(
  input: HarnessStepInput | undefined,
  isSettled: (responseId: string) => boolean,
): HarnessStepInput | undefined {
  if (input === undefined) return undefined;
  const settledResponse = (response: Answer) => {
    const binding = responseBindingFor(input, response);
    return binding !== undefined && isSettled(binding.responseId);
  };
  const result: { -readonly [K in keyof HarnessStepInput]: HarnessStepInput[K] } = { ...input };
  const bindings = input.responseBindings?.filter((binding) => !isSettled(binding.responseId));
  const responses = input.answers?.filter((response) => !settledResponse(response));
  const attributed = input.attributedAnswers?.filter(({ response }) => !settledResponse(response));
  if (bindings === undefined || bindings.length === 0) delete result.responseBindings;
  else result.responseBindings = bindings;
  if (responses === undefined || responses.length === 0) delete result.answers;
  else result.answers = responses;
  if (attributed === undefined || attributed.length === 0) delete result.attributedAnswers;
  else result.attributedAnswers = attributed;
  return result;
}

function withQueued(turn: TurnState, queued: HarnessStepInput | undefined): TurnState {
  if (queued === undefined || isEmptyInput(queued)) return turn;
  return {
    ...turn,
    queued: turn.queued === undefined ? queued : coalesceTurnInputs(turn.queued, queued),
  };
}

// ---------------------------------------------------------------------------
// answer
// ---------------------------------------------------------------------------

/** What the approval-response policies did with a delivery, before `answer` reads it. */
export interface ResponsePolicyPass {
  readonly kind:
    | "continue"
    | "continue-coordination"
    | "authorization-required"
    | "responses-completed";
  readonly challenges: readonly AuthorizationChallenge[];
  readonly feedback: readonly string[];
  /** The delivery minus the answers the policies took, plus the settlements they reached. */
  readonly stepInput?: HarnessStepInput;
  readonly audit: ReturnType<typeof getApprovalAuditState>;
  /** Responder sign-ins pending when the pass began. */
  readonly challengesAtStart: readonly AuthorizationChallenge[];
  /** Answers a check refused before any policy ran. */
  readonly refused?: readonly RefusedResponse[];
}

/** What `answer` concluded, beyond the events and state it changed. */
export interface Answered extends Transition {
  /**
   * `continue`: the step goes on. `park`: nothing can run until more input arrives.
   * `repeat`: a policy pass committed, so the next pass runs in a fresh step. `sign-in`: a
   * responder must sign in first.
   */
  readonly next: "continue" | "park" | "repeat" | "sign-in";
  /** The turn's input, without the answers `answer` consumed. */
  readonly input?: HarnessStepInput;
  /** Whether a plain-text answer consumed the message. */
  readonly consumedMessage?: boolean;
  /** Whether a batch of approvals settled on its answers, rather than a message steering past. */
  readonly answeredApprovals?: boolean;
  /** A decision on the session-limit prompt. */
  readonly limit?: { readonly granted: boolean };
}

/**
 * A delivery answers what the session asked. An approval batch resolves once every request in it
 * has a decision: approved calls become ready to run, denied ones get their denial as a result,
 * and `once()` approvals grant their key. A message steers the held turn instead: the first
 * pending batch resolves with the answers it has, and the rest are ignored. A session-limit
 * answer grants or declines a fresh budget. A partial answer waits, queued, for the rest.
 */
export function answer(
  view: SessionView,
  input: {
    readonly delivery: ResolvedStepInput | undefined;
    readonly policy: ResponsePolicyPass;
    /** The delivery merged the queue in, so the queue empties. */
    readonly takeQueued: boolean;
    /** The answers the delivery carried, as admitted: each is submitted once. */
    readonly submitted?: readonly ResponseSubmittedData[];
    readonly approvalKey: (ask: ApprovalAsk) => string | undefined;
    /**
     * Whether the request's restored step has `eve__search`, which a call whose
     * tool is gone can use to find another.
     */
    readonly searchable: (ask: ApprovalAsk) => boolean;
  },
): Answered {
  const { policy } = input;
  const { projection } = view;
  const tables = publicViewOf(projection);
  const responses = responseLedger(tables, input.submitted ?? []);
  // What a responder may not do refuses their delivery, with why: a notice, not the model's.
  const refusal = policy.feedback.join("\n");
  const refused: SessionEvent[] =
    policy.feedback.length === 0
      ? []
      : (input.delivery?.deliveries ?? []).map(({ deliveryId }) => ({
          data: { deliveryId, outcome: "refused", reason: refusal },
          type: "delivery.settled",
        }));
  for (const { reason, responseId } of policy.refused ?? []) {
    responses.settle(responseId, "refused", reason);
  }
  reportResponderProgress(tables, responses, policy);
  const events: SessionEvent[] = [...refused, ...signInProgress(tables, policy)];
  let turn: TurnState = input.takeQueued ? { ...view.turn, queued: undefined } : view.turn;
  const done = ({
    events: decided = [],
    ...answered
  }: Omit<Answered, "events" | "turn"> & Partial<Answered>) =>
    ({
      events: [...responses.facts(), ...events, ...decided],
      turn,
      ...answered,
    }) satisfies Answered;
  // An answer that already settled, as one a response policy refused, never waits to be
  // submitted again.
  const queue = (queued: HarnessStepInput | undefined) => {
    turn = withQueued(turn, withoutSettledAnswers(queued, responses.isSettled));
  };
  // Answers without a policy to pass are admitted as they arrive: they stand, revisable, until
  // their batch has every answer.
  const admitUnchecked = (delivery: HarnessStepInput | undefined) => {
    const gated = new Set(
      turn.suspended.flatMap((step) => step.responseAuthRequiredRequestIds ?? []),
    );
    for (const response of canonicalize(delivery?.answers ?? [])) {
      if (gated.has(response.interactionId)) continue;
      const binding = responseBindingFor(delivery, response);
      if (binding !== undefined) responses.admit(binding.responseId);
    }
  };

  if (policy.kind === "continue-coordination") {
    queue(policy.stepInput);
    return done({ next: "repeat" });
  }
  if (policy.challenges.length > 0) return done({ next: "sign-in" });

  const delivery = input.delivery;
  const limit = openLimit(view);
  const answerable = turn.suspended.filter((step) => step.requests.length > 0);
  if (limit === undefined && answerable.length === 0) {
    return done({ input: delivery, next: "continue" });
  }

  // The approval coordinator already answered a typed approval; see `resolveTypedApproval`.
  const resolved =
    limit === undefined ? delivery : resolveTextInput({ requests: [limit.row] }, delivery);
  // A typed answer to the prompt is an answer like a press.
  responses.submit(resolved?.responseBindings ?? []);
  const answers = canonicalize(resolved?.answers ?? []);
  const byId = new Map(answers.map((answer) => [answer.interactionId, answer]));
  const answered = answerable.filter((step) =>
    step.requests.every((ask) => byId.has(ask.interactionId)),
  );
  const leftoverFor = (steps: readonly SuspendedStep[]) =>
    answers.filter((answer) =>
      steps.some((step) => step.requests.some((ask) => ask.interactionId === answer.interactionId)),
    );
  // Nothing runs: the input waits, and the held turn stays held.
  const park = () => {
    admitUnchecked(resolved);
    queue(compactInput(resolved));
    return done({ next: "park" });
  };
  if (answers.length === 0 && resolved?.message === undefined) return park();
  // The answer that decides a request: the latest one it was given.
  const decider = (interactionId: string, answer: Answer | undefined) =>
    answer === undefined
      ? undefined
      : (responseBindingFor(resolved, answer)?.responseId ??
        policy.audit.settlements.find((entry) => entry.requestId === interactionId)?.candidateId ??
        responses.latest(interactionId));
  const decide = (
    interactionId: string,
    response: Answer | undefined,
    outcome: InteractionOutcome,
    scope: { readonly turnId: string },
    reason?: string,
  ): SessionEvent[] => {
    const candidate = decider(interactionId, response);
    const responseId =
      candidate !== undefined && responses.known(candidate) ? candidate : undefined;
    if (responseId !== undefined) responses.settle(responseId, "applied");
    responses.closeOthers(interactionId, responseId);
    return [
      interactionSettled(interactionId, outcome, {
        cause: responseId === undefined ? undefined : { responseId },
        reason,
        response,
        scope,
      }),
    ];
  };

  if (limit !== undefined) {
    const { interactionId } = limit.row;
    const response = byId.get(interactionId);
    // A message waits behind the prompt with everything else, unreceived, until it's answered.
    if (response === undefined) return park();
    const granted = limitDecision(response);
    if (granted === undefined) {
      // Neither Continue nor Stop: the answer is refused, and the prompt stays open for another.
      const candidate = decider(interactionId, response);
      if (candidate !== undefined && responses.known(candidate))
        responses.settle(candidate, "refused", INVALID_BUDGET_ANSWER);
      queue(compactInput(withoutAnswersTo(resolved, interactionId)));
      return done({ next: "park" });
    }
    const at = turnCoordinatesOf(projection, limit.turnId ?? turnCoordinates(projection).turnId);
    const outcome = granted.granted ? "accepted" : "declined";
    const settled = decide(interactionId, response, outcome, { turnId: at.turnId });
    const leftover = leftoverFor(answerable);
    if (leftover.length > 0) queue({ answers: leftover });
    return done({
      consumedMessage: resolved?.messageConsumed,
      events: settled,
      input: withoutResponses(resolved),
      limit: granted,
      next: "continue",
    });
  }

  if (answered.length === 0 && resolved?.message === undefined) return park();
  // A message steers the held turn past its first pending batch: the answers it has stand, and
  // the requests nobody answered are withdrawn. Later batches stay open.
  const answeredApprovals = answered.length > 0;
  if (!answeredApprovals) answered.push(answerable[0]!);
  const leftover = leftoverFor(answerable.filter((step) => !answered.includes(step)));
  if (leftover.length > 0) queue({ answers: leftover });

  const grants = new Set(turn.grants);
  const results: SessionEvent[] = [];
  const unavailable = new Map(
    policy.audit.settlements
      .filter((settlement) => settlement.outcome === "unavailable")
      .map((settlement) => [settlement.requestId, settlement]),
  );
  const suspended = turn.suspended.map((step) => {
    if (!answered.includes(step)) return step;
    let messages = step.messages;
    const approvedRequests: ApprovalAsk[] = [];
    const scope = { turnId: step.event.turnId };
    for (const request of step.requests) {
      const { interactionId } = request;
      const { callId, toolName } = request.call;
      const response = byId.get(interactionId);
      if (unavailable.has(interactionId)) {
        const message = unavailableToolMessage(toolName, input.searchable(request));
        const failed = failedCall({ callId, message, toolName });
        messages = withResult(messages, failed.part);
        // Its tool is gone, so no answer can run the call: nobody needs the approval anymore.
        responses.closeOthers(interactionId, undefined);
        results.push(
          interactionSettled(interactionId, "withdrawn", { reason: message, scope }),
          callSettledFrom(failed.result, { scope }),
        );
        continue;
      }
      const { approved, reason, status } = resolveApprovalOutcome(response);
      if (approved) {
        grants.add(input.approvalKey(request) ?? toolName);
        approvedRequests.push(request);
        results.push(...decide(interactionId, response, "accepted", scope));
        continue;
      }
      const outcome =
        status === "ignored" ? "withdrawn" : status === "invalid" ? "invalid" : "declined";
      results.push(
        ...(status === "ignored"
          ? decide(interactionId, undefined, outcome, scope, SUPERSEDED_BY_MESSAGE)
          : decide(interactionId, response, outcome, scope)),
      );
      messages = withResult(messages, {
        output: { reason, type: "execution-denied" },
        toolCallId: callId,
        toolName,
        type: "tool-result",
      });
      const settled = callSettledFrom(
        {
          callId,
          isError: true,
          kind: "tool-result",
          output: {
            approval: { interactionId, status },
            code: "TOOL_EXECUTION_DENIED",
            message: reason ?? TOOL_EXECUTION_DENIED_MESSAGE,
            tool: { result: "not_run" },
          },
          toolName,
        },
        { rejected: true, scope },
      );
      results.push({
        ...settled,
        data: { ...settled.data, cause: { interactionId } },
      });
    }
    const approved = [...(step.approved ?? []), ...approvedRequests];
    return { ...step, messages, requests: [], ...(approved.length > 0 && { approved }) };
  });
  // Answers to batches still waiting for more stand, admitted, until theirs completes.
  admitUnchecked({ ...resolved, answers: leftover });
  turn = { ...turn, grants: [...grants], suspended };
  return done({
    answeredApprovals,
    consumedMessage: resolved?.messageConsumed,
    events: results,
    input: withoutResponses(resolved),
    next: "continue",
  });
}

/**
 * The responses a commit records: each answer submitted once, its checks, and how it settled.
 * Revising an admitted answer abandons the one it replaces; an interaction that settles
 * withdraws the open answers that didn't decide it.
 */
interface ResponseLedger {
  /** Records answers not seen yet; one to a request nobody can answer anymore is dropped. */
  submit(bindings: readonly ResponseSubmittedData[]): void;
  /** Whether this commit or an earlier one recorded the answer. */
  known(responseId: string): boolean;
  /** Whether the answer settled, in this commit or an earlier one. */
  isSettled(responseId: string): boolean;
  admit(responseId: string): void;
  settle(responseId: string, outcome: ResponseOutcome, reason?: string): void;
  /** Settles every other open answer to an interaction that `decidedBy` settles. */
  closeOthers(interactionId: string, decidedBy: string | undefined): void;
  /** The latest open answer to an interaction. */
  latest(interactionId: string): string | undefined;
  facts(): SessionEvent[];
}

function responseLedger(
  tables: PublicView,
  submitted: readonly ResponseSubmittedData[],
): ResponseLedger {
  const facts: SessionEvent[] = [];
  const fresh = new Map<string, ResponseSubmittedData>();
  const status = new Map<string, "submitted" | "admitted" | "settled">();
  for (const row of Object.values(tables.responses)) status.set(row.responseId, row.status);
  const submit = (bindings: readonly ResponseSubmittedData[]) => {
    for (const binding of bindings) {
      if (status.has(binding.responseId)) continue;
      // An answer to a request nobody can answer anymore introduces nothing: it was converted
      // or dropped before it got here.
      if (tables.interactions[binding.interactionId]?.status !== "open") continue;
      fresh.set(binding.responseId, binding);
      status.set(binding.responseId, "submitted");
      facts.push(responseSubmitted(binding));
    }
  };
  submit(submitted);
  const interactionOf = (responseId: string) =>
    fresh.get(responseId)?.interactionId ?? tables.responses[responseId]?.interactionId;
  const order = (responseId: string) =>
    tables.responses[responseId]?.introducedAt ?? Number.MAX_SAFE_INTEGER;
  const openFor = (interactionId: string) =>
    [...status]
      .filter(([id, state]) => state !== "settled" && interactionOf(id) === interactionId)
      .map(([id]) => id)
      .sort((a, b) => order(a) - order(b));
  const settle = (responseId: string, outcome: ResponseOutcome, reason?: string) => {
    const current = status.get(responseId);
    if (current === undefined || current === "settled") return;
    status.set(responseId, "settled");
    facts.push(responseSettled(responseId, outcome, reason));
  };
  return {
    admit(responseId) {
      if (status.get(responseId) !== "submitted") return;
      const interactionId = interactionOf(responseId);
      if (interactionId !== undefined) {
        for (const other of openFor(interactionId)) {
          if (other !== responseId && status.get(other) === "admitted")
            settle(other, "abandoned", "revised");
        }
      }
      status.set(responseId, "admitted");
      facts.push(responseAdmitted(responseId));
    },
    closeOthers(interactionId, decidedBy) {
      for (const other of openFor(interactionId)) {
        if (other === decidedBy) continue;
        settle(other, status.get(other) === "admitted" ? "abandoned" : "withdrawn");
      }
    },
    facts: () => facts,
    known: (responseId) => status.has(responseId),
    isSettled: (responseId) => status.get(responseId) === "settled",
    submit,
    latest(interactionId) {
      return openFor(interactionId).at(-1);
    },
    settle,
  };
}

/**
 * What the response policies concluded since the last pass, by response: a responder they
 * refused, an answer that failed or expired, or one another responder's answer made moot. An
 * answer a policy allowed stands, admitted, until its batch decides.
 */
function reportResponderProgress(
  tables: PublicView,
  responses: ResponseLedger,
  policy: ResponsePolicyPass,
): void {
  for (const candidate of policy.audit.candidateHistory) {
    if (tables.responses[candidate.candidateId] === undefined) continue;
    switch (candidate.status) {
      case "rejected":
        responses.settle(candidate.candidateId, "refused", candidate.reason);
        break;
      case "failed":
        responses.settle(candidate.candidateId, "failed", candidate.reason);
        break;
      case "timed-out":
        responses.settle(candidate.candidateId, "expired", candidate.reason);
        break;
      case "stale":
        responses.settle(candidate.candidateId, "withdrawn", candidate.reason);
        break;
      default:
        break;
    }
  }
  for (const settlement of policy.audit.settlements) {
    if (settlement.candidateId !== undefined && settlement.outcome !== "unavailable")
      responses.admit(settlement.candidateId);
  }
}

/** A responder's sign-in whose candidate expired ends with it. */
function signInProgress(tables: PublicView, policy: ResponsePolicyPass): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (const challenge of policy.challengesAtStart) {
    const expired = policy.audit.candidateHistory.some(
      (candidate) =>
        candidate.candidateId === challenge.candidateId && candidate.status === "timed-out",
    );
    const interactionId = signInInteractionId(challenge);
    if (!expired || tables.interactions[interactionId]?.status !== "open") continue;
    events.push(
      interactionSettled(interactionId, "expired", {
        reason: "The approval response expired. Please submit a new response.",
      }),
    );
  }
  return events;
}

/** Queued input that can run now, rather than wait for more answers. */
export function hasRunnableQueue(view: SessionView): boolean {
  const queued = view.turn.queued;
  if (queued === undefined) return false;
  const responses = [
    ...(queued.answers ?? []),
    ...(queued.attributedAnswers ?? []).map(({ response }) => response),
  ];
  const answered = new Set(responses.map((response) => response.interactionId));
  // A message waits for the budget answer too: the turn holds until the prompt is answered.
  const limit = openRequests(publicViewOf(view.projection)).find(
    (open) => open.request.kind === "budget",
  );
  if (limit !== undefined) return answered.has(limit.interactionId);
  if (
    queued.message !== undefined ||
    (queued.context?.length ?? 0) > 0 ||
    readClientContext(queued) !== undefined ||
    queued.outputSchema !== undefined ||
    (queued.runtimeActionResults?.length ?? 0) > 0
  ) {
    return true;
  }
  if (responses.length === 0) return false;
  return view.turn.suspended.some(
    (step) =>
      step.requests.length > 0 && step.requests.every((ask) => answered.has(ask.interactionId)),
  );
}

/** Keys `once()` approvals granted, except those a pending approval still asks about. */
export function grantedApprovalKeys(
  view: SessionView,
  approvalKey: (ask: ApprovalAsk) => string | undefined,
): ReadonlySet<string> {
  const granted = new Set(view.turn.grants);
  for (const step of view.turn.suspended) {
    for (const ask of step.requests) granted.delete(approvalKey(ask) ?? ask.call.toolName);
  }
  return granted;
}

/**
 * The steps a delivery approves calls of, whose tools the calls run with: those it answers in
 * full, approving at least one call.
 */
export function approvingSteps(
  view: SessionView,
  stepInput: HarnessStepInput | undefined,
): readonly SuspendedStep[] {
  const pending = view.turn.suspended.filter((step) => step.requests.length > 0);
  const options = new Map(
    (stepInput?.answers ?? []).map((answer) => [answer.interactionId, answer.optionId]),
  );
  return pending.filter(
    (step) =>
      step.requests.every((ask) => options.has(ask.interactionId)) &&
      step.requests.some((ask) => options.get(ask.interactionId) === "approve"),
  );
}

/** The suspended step that holds `interactionId`. */
export function stepForRequest(
  view: SessionView,
  interactionId: string,
): SuspendedStep | undefined {
  return view.turn.suspended.find((step) =>
    step.requests.some((ask) => ask.interactionId === interactionId),
  );
}

/**
 * The held turn moves on, steered: the sign-ins it waits on are withdrawn, including a
 * responder's for one of its approvals, and the calls that waited for them fail with `reason`.
 */
export function withdrawSignIns(view: SessionView, reason: string): Transition {
  const tables = publicViewOf(view.projection);
  const waiting = view.turn.suspended.flatMap((step) =>
    (step.approved ?? []).filter((call) => !runnableCalls(view, step).includes(call)),
  );
  const withdrawn = [...view.signIns, ...waiting.flatMap((call) => call.signIns ?? [])];
  const events = [
    ...new Map(withdrawn.map((challenge) => [signInAttemptKey(challenge), challenge])).values(),
  ].flatMap((challenge) => {
    const interactionId = signInInteractionId(challenge);
    return tables.interactions[interactionId]?.status === "open"
      ? [interactionSettled(interactionId, "withdrawn", { reason })]
      : [];
  });
  const settled = settle(view, {
    results: waiting.map(({ call }) =>
      failedCall({ callId: call.callId, message: reason, toolName: call.toolName }),
    ),
  });
  return { ...settled, events: [...events, ...settled.events], signIns: [] };
}

// ---------------------------------------------------------------------------
// requestLimit
// ---------------------------------------------------------------------------

/** Why an answer to the budget prompt that is neither Continue nor Stop doesn't count. */
const INVALID_BUDGET_ANSWER = "The budget prompt takes Continue or Stop.";

/** `input` without its answers to `interactionId`. */
function withoutAnswersTo(
  input: HarnessStepInput | undefined,
  interactionId: string,
): HarnessStepInput | undefined {
  if (input === undefined) return undefined;
  return {
    ...input,
    answers: input.answers?.filter((answer) => answer.interactionId !== interactionId),
    attributedAnswers: input.attributedAnswers?.filter(
      ({ response }) => response.interactionId !== interactionId,
    ),
  };
}

/** The budget prompt the session waits on, with the turn it asked in, if any. */
export function openLimit(
  view: SessionView,
): { readonly row: InteractionRow; readonly turnId?: string } | undefined {
  const own = ownOpenRequestIds(view);
  const tables = publicViewOf(view.projection);
  const row = openRequests(tables).find(
    (open) => open.request.kind === "budget" && own.has(open.interactionId),
  );
  return row === undefined ? undefined : { row, turnId: interactionOwner(tables, row).turnId };
}

/**
 * The session spent its budget: it asks whether to continue instead of calling the model, and
 * the turn waits on the prompt. `answer` grants a fresh budget or declines it.
 */
export function requestLimit(view: SessionView, ask: LimitAsk): Transition {
  const { turnId } = turnPosition(view.projection);
  return {
    events: [interactionOpened({ ...ask, scope: { turnId }, subject: { turnId } })],
    turn: view.turn,
  };
}

// ---------------------------------------------------------------------------
// requireSignIn
// ---------------------------------------------------------------------------

/**
 * Work needs a sign-in. The calls that need it stop and wait in their steps; an attempt it
 * replaces fails; and each sign-in is asked for and recorded. The turn holds until every sign-in
 * calls back, and then the stopped calls run. Input that waited on a responder's sign-in stays
 * queued for it.
 */
export function requireSignIn(
  view: SessionView,
  input: {
    readonly challenges: readonly AuthorizationChallenge[];
    readonly calls?: readonly StoppedCall[];
    readonly queued?: HarnessStepInput;
  },
): Transition {
  const { turnId } = turnPosition(view.projection);
  const tables = publicViewOf(view.projection);
  const opening = input.challenges.filter(
    (challenge) => tables.interactions[signInInteractionId(challenge)] === undefined,
  );
  // A call a sign-in stopped stays open in its step and runs once the sign-in completes, so its
  // settlement reports how the sign-in came out (`callSignInsSettled`).
  const events: SessionEvent[] = [
    // A newer attempt replaces the one it supersedes.
    ...supersededChallenges(view.signIns, input.challenges).flatMap((superseded) => {
      const interactionId = signInInteractionId(superseded);
      return tables.interactions[interactionId]?.status === "open"
        ? [
            interactionSettled(interactionId, "abandoned", {
              reason: "Superseded by a newer authorization attempt.",
            }),
          ]
        : [];
    }),
    ...opening.map((challenge) =>
      signInOpened(challenge, {
        scope: { turnId },
        // A responder's sign-in is about their answer; any other holds the turn.
        subject:
          challenge.candidateId !== undefined &&
          tables.responses[challenge.candidateId] !== undefined
            ? { responseId: challenge.candidateId }
            : { turnId },
      }),
    ),
  ];
  const queued =
    input.queued === undefined
      ? view.turn.queued
      : view.turn.queued === undefined
        ? input.queued
        : coalesceTurnInputs(view.turn.queued, input.queued);
  const signIns = withSignIns(view.signIns, input.challenges);
  const { calls } = input;
  const suspended =
    calls === undefined
      ? view.turn.suspended
      : view.turn.suspended.map((step) =>
          awaitSignIns(step, { challenges: input.challenges, stopped: calls }),
        );
  return { events, signIns, turn: { ...view.turn, queued, suspended } };
}
