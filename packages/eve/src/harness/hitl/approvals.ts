import type { SessionEvent } from "#protocol/session-event.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { ModelMessage } from "ai";

import type { getApprovalAuditState } from "#harness/hitl/candidates.js";
import {
  supersededChallenges,
  withSignIns,
  type AuthorizationChallenge,
} from "#harness/authorization.js";
import { renderPendingApprovalsSnippet } from "#harness/hitl/approval-prompt.js";
import { isApprovalRequest } from "#harness/input-request-class.js";
import {
  failedCall,
  resolveApprovalOutcome,
  resolveInputOutcome,
  TOOL_EXECUTION_DENIED_MESSAGE,
  unavailableToolMessage,
  type ResolvedInputBatch,
} from "#harness/input-request-resolution.js";
import { coalesceTurnInputs, createFrameworkUserMessage } from "#harness/messages.js";
import { resolveSessionLimitContinuation } from "#harness/hitl/budget-request.js";
import type { StepInput } from "#harness/types.js";
import { readClientContext } from "#internal/client-context.js";
import { callSettledFrom } from "#harness/call-facts.js";
import {
  interactionOpened,
  interactionSettled,
  responseAdmitted,
  responseSettled,
  responseSubmitted,
  signInInteractionId,
  signInOpened,
} from "#harness/interaction-facts.js";
import { responseBindingFor } from "#harness/response-bindings.js";
import { publicViewOf } from "#harness/session-machine/closure.js";
import type { RefusedResponse } from "#harness/hitl/coordinator.js";
import { openInputs, SUPERSEDED_BY_MESSAGE } from "#protocol/session-projection.js";
import type { InteractionOutcome } from "#protocol/session-events/families/interaction.js";
import type {
  ResponseOutcome,
  ResponseSubmittedData,
} from "#protocol/session-events/families/response.js";
import type { SessionView as PublicView } from "#protocol/session-projection/tables.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import type { InputRequest, InputResponse } from "#shared/input.js";
import type { Transition } from "#harness/session-machine/commit.js";
import {
  canonicalize,
  compactInput,
  hasInput,
  isEmptyInput,
  resolveTextInput,
  withoutResponses,
  withoutTurnInput,
  type ResolvedStepInput,
} from "./delivery.js";
import type { StepCoordinates, SuspendedStep, TurnState } from "#harness/session-machine/view.js";
import { withoutCalls } from "#harness/inline-tool-authorization.js";
import {
  hold,
  ownOpenRequestIds,
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
    readonly requests: readonly InputRequest[];
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
        : input.requests.map((request) =>
            interactionOpened(request, { scope: { turnId: input.event.turnId } }),
          ),
    turn,
  };
}

/** Approved workflow and agent calls join the runs their steps wait on, as their approvers. */
export function dispatch(
  view: SessionView,
  input: {
    readonly approvers: Readonly<Record<string, SessionAuthContext>>;
    readonly tasks: readonly RuntimeWorkflowTaskRequest[];
  },
): Transition {
  const suspended = view.turn.suspended.map((step) => {
    const calls = stepCallIds(step);
    const tasks = input.tasks.filter((task) => calls.has(task.callId));
    if (tasks.length === 0) return step;
    const dispatched = withoutApproved(step, new Set(tasks.map((task) => task.callId)));
    const approvers = { ...step.approvers };
    for (const { callId } of tasks) {
      const approver = input.approvers[callId];
      if (approver !== undefined) approvers[callId] = approver;
    }
    return {
      ...dispatched,
      tasks: [...step.tasks, ...tasks],
      ...(Object.keys(approvers).length > 0 && { approvers }),
    };
  });
  return { events: [], turn: { ...view.turn, suspended } };
}

/**
 * Approved calls run before the delivery's own input, as the AI SDK ran them: the model reads
 * their results first. The input waits in the queue, unreceived, for the step after.
 */
export function deferInput(view: SessionView, input: StepInput): Transition {
  return { events: [], turn: withQueued(view.turn, input) };
}

function withQueued(turn: TurnState, queued: StepInput | undefined): TurnState {
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
    | "responses-completed"
    | "park";
  readonly challenges: readonly AuthorizationChallenge[];
  readonly feedback: readonly string[];
  /** The delivery minus the answers the policies took, plus the settlements they reached. */
  readonly stepInput?: StepInput;
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
   * responder must sign in first. `defer-message`: a message arrived while the session-limit
   * prompt is open; it waits in its turn for the prompt.
   */
  readonly next: "continue" | "park" | "repeat" | "sign-in" | "defer-message";
  /** The turn's input, without the answers `answer` consumed. */
  readonly input?: StepInput;
  /** Whether a plain-text answer consumed the message. */
  readonly consumedMessage?: boolean;
  /** The batches the delivery resolved, in order. */
  readonly resolved: readonly ResolvedInputBatch[];
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
    readonly approvalKey: (request: InputRequest) => string | undefined;
    /**
     * Whether the request's restored step has `eve__search`, which a call whose
     * tool is gone can use to find another.
     */
    readonly searchable: (request: InputRequest) => boolean;
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
  }: Omit<Answered, "events" | "turn" | "resolved"> & Partial<Answered>) =>
    ({
      events: [...responses.facts(), ...events, ...decided],
      resolved: [],
      turn,
      ...answered,
    }) satisfies Answered;
  const queue = (queued: StepInput | undefined) => {
    turn = withQueued(turn, queued);
  };
  // Answers without a policy to pass are admitted as they arrive: they stand, revisable, until
  // their batch has every answer.
  const admitUnchecked = (delivery: StepInput | undefined) => {
    const gated = new Set(
      turn.suspended.flatMap((step) => step.responseAuthRequiredRequestIds ?? []),
    );
    for (const response of canonicalize(delivery?.inputResponses ?? [])) {
      if (gated.has(response.requestId)) continue;
      const binding = responseBindingFor(delivery, response);
      if (binding !== undefined) responses.admit(binding.responseId);
    }
  };

  if (policy.kind === "park") return done({ next: "park" });
  if (policy.kind === "continue-coordination") {
    queue(policy.stepInput);
    return done({ next: "repeat" });
  }
  if (policy.challenges.length > 0) return done({ next: "sign-in" });

  const delivery = input.delivery;
  const limit = openInputs(projection).find(
    (open) =>
      open.request.kind === "session-limit" && ownOpenRequestIds(view).has(open.request.requestId),
  );
  const answerable = turn.suspended.filter((step) => step.requests.length > 0);
  if (limit === undefined && answerable.length === 0) {
    return done({ input: delivery, next: "continue" });
  }

  // The approval coordinator already answered a typed approval; see `resolveTypedApproval`.
  const resolved =
    limit === undefined ? delivery : resolveTextInput({ requests: [limit.request] }, delivery);
  // A typed answer to the prompt is an answer like a press.
  responses.submit(resolved?.responseBindings ?? []);
  const answers = canonicalize(resolved?.inputResponses ?? []);
  const byId = new Map(answers.map((response) => [response.requestId, response]));
  const answered = answerable.filter((step) =>
    step.requests.every((request) => byId.has(request.requestId)),
  );
  const leftoverFor = (steps: readonly SuspendedStep[]) =>
    answers.filter((response) =>
      steps.some((step) =>
        step.requests.some((request) => request.requestId === response.requestId),
      ),
    );
  // Nothing runs: the input waits, and the held turn stays held.
  const park = () => {
    admitUnchecked(resolved);
    queue(compactInput(resolved));
    return done({ next: "park" });
  };
  if (answers.length === 0 && resolved?.message === undefined) return park();
  // The answer that decides a request: the latest one it was given.
  const decider = (request: InputRequest, response: InputResponse | undefined) =>
    response === undefined
      ? undefined
      : (responseBindingFor(resolved, response)?.responseId ??
        policy.audit.settlements.find((entry) => entry.requestId === request.requestId)
          ?.candidateId ??
        responses.latest(request.requestId));
  const decide = (
    request: InputRequest,
    response: InputResponse | undefined,
    outcome: InteractionOutcome,
    scope: { readonly turnId: string },
    reason?: string,
  ): SessionEvent[] => {
    const candidate = decider(request, response);
    const responseId =
      candidate !== undefined && responses.known(candidate) ? candidate : undefined;
    if (responseId !== undefined) responses.settle(responseId, "applied");
    responses.closeOthers(request.requestId, responseId);
    return [
      interactionSettled(request.requestId, outcome, {
        cause: responseId === undefined ? undefined : { responseId },
        reason,
        response,
        scope,
      }),
    ];
  };

  if (limit !== undefined) {
    const response = byId.get(limit.request.requestId);
    if (response === undefined) {
      if (!hasInput(delivery)) {
        queue(compactInput(resolved));
        return done({ next: "park" });
      }
      // The message is received now, into the turn that holds for the prompt: only answers to
      // other requests wait for the grant. What waits in the queue was never received.
      queue(withoutTurnInput(resolved));
      return done({ input: resolved, next: "defer-message" });
    }
    const batch: ResolvedInputBatch = {
      event: { sequence: limit.sequence, stepIndex: limit.stepIndex, turnId: limit.turnId },
      inputs: [
        {
          outcome: resolveInputOutcome(limit.request.kind, response),
          request: limit.request,
          response,
        },
      ],
    };
    const granted = resolveSessionLimitContinuation({
      requests: [limit.request],
      responses: answers,
    });
    const settled = decide(
      limit.request,
      response,
      granted === undefined ? "invalid" : granted.granted ? "accepted" : "declined",
      { turnId: limit.turnId },
    );
    const leftover = leftoverFor(answerable);
    if (leftover.length > 0) queue({ inputResponses: leftover });
    return done({
      consumedMessage: resolved?.messageConsumed,
      events: settled,
      input: withoutResponses(resolved),
      limit: granted,
      next: "continue",
      resolved: [batch],
    });
  }

  if (answered.length === 0 && resolved?.message === undefined) return park();
  // A message steers the held turn past its first pending batch: the answers it has stand, and
  // the requests nobody answered are withdrawn. Later batches stay open.
  if (answered.length === 0) answered.push(answerable[0]!);
  const leftover = leftoverFor(answerable.filter((step) => !answered.includes(step)));
  if (leftover.length > 0) queue({ inputResponses: leftover });

  const grants = new Set(turn.grants);
  const batches: ResolvedInputBatch[] = [];
  const results: SessionEvent[] = [];
  const unavailable = new Map(
    policy.audit.settlements
      .filter((settlement) => settlement.outcome === "unavailable")
      .map((settlement) => [settlement.requestId, settlement]),
  );
  const suspended = turn.suspended.map((step) => {
    if (!answered.includes(step)) return step;
    let messages = step.messages;
    const approvedRequests: InputRequest[] = [];
    const scope = { turnId: step.event.turnId };
    for (const request of step.requests) {
      const { callId, toolName } = request.action;
      const response = byId.get(request.requestId);
      if (unavailable.has(request.requestId)) {
        const message = unavailableToolMessage(toolName, input.searchable(request));
        const failed = failedCall({ callId, message, toolName });
        messages = withResult(messages, failed.part);
        // Its tool is gone, so no answer can run the call: nobody needs the approval anymore.
        responses.closeOthers(request.requestId, undefined);
        results.push(
          interactionSettled(request.requestId, "withdrawn", { reason: message, scope }),
          callSettledFrom(failed.result, { scope }),
        );
        continue;
      }
      const { approved, reason, status } = resolveApprovalOutcome(response);
      if (approved) {
        grants.add(input.approvalKey(request) ?? toolName);
        approvedRequests.push(request);
        results.push(...decide(request, response, "accepted", scope));
        continue;
      }
      results.push(
        ...(status === "ignored"
          ? decide(request, undefined, "withdrawn", scope, SUPERSEDED_BY_MESSAGE)
          : decide(request, response, status === "invalid" ? "invalid" : "declined", scope)),
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
            approval: { requestId: request.requestId, status },
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
        data: { ...settled.data, cause: { interactionId: request.requestId } },
      });
    }
    batches.push({
      event: step.event,
      inputs: step.requests.map((request) => {
        const answer = byId.get(request.requestId);
        return { outcome: resolveInputOutcome(request.kind, answer), request, response: answer };
      }),
    });
    const approved = [...(step.approved ?? []), ...approvedRequests];
    return { ...step, messages, requests: [], ...(approved.length > 0 && { approved }) };
  });
  // Answers to batches still waiting for more stand, admitted, until theirs completes.
  admitUnchecked({ ...resolved, inputResponses: leftover });
  turn = { ...turn, grants: [...grants], suspended };
  return done({
    consumedMessage: resolved?.messageConsumed,
    events: results,
    input: withoutResponses(resolved),
    next: "continue",
    resolved: batches,
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
  if (
    queued.message !== undefined ||
    (queued.context?.length ?? 0) > 0 ||
    readClientContext(queued) !== undefined ||
    queued.outputSchema !== undefined ||
    (queued.runtimeActionResults?.length ?? 0) > 0
  ) {
    return true;
  }
  const responses = [
    ...(queued.inputResponses ?? []),
    ...(queued.attributedInputResponses ?? []).map(({ response }) => response),
  ];
  if (responses.length === 0) return false;
  const answered = new Set(responses.map((response) => response.requestId));
  const limit = openInputs(view.projection).find((open) => open.request.kind === "session-limit");
  if (limit !== undefined) return answered.has(limit.request.requestId);
  return view.turn.suspended.some(
    (step) =>
      step.requests.length > 0 && step.requests.every((request) => answered.has(request.requestId)),
  );
}

/** Keys `once()` approvals granted, except those a pending approval still asks about. */
export function grantedApprovalKeys(
  view: SessionView,
  approvalKey: (request: InputRequest) => string | undefined,
): ReadonlySet<string> {
  const granted = new Set(view.turn.grants);
  for (const step of view.turn.suspended) {
    for (const request of step.requests) {
      if (isApprovalRequest(request))
        granted.delete(approvalKey(request) ?? request.action.toolName);
    }
  }
  return granted;
}

/**
 * The steps a delivery approves calls of, whose tools the calls run with: those it answers in
 * full, approving at least one call.
 */
export function approvingSteps(
  view: SessionView,
  stepInput: StepInput | undefined,
): readonly SuspendedStep[] {
  const pending = view.turn.suspended.filter((step) => step.requests.length > 0);
  const options = new Map(
    (stepInput?.inputResponses ?? []).map((response) => [response.requestId, response.optionId]),
  );
  return pending.filter(
    (step) =>
      step.requests.every((request) => options.has(request.requestId)) &&
      step.requests.some(
        (request) => isApprovalRequest(request) && options.get(request.requestId) === "approve",
      ),
  );
}

/** The suspended step that holds `requestId`. */
export function stepForRequest(view: SessionView, requestId: string): SuspendedStep | undefined {
  return view.turn.suspended.find((step) =>
    step.requests.some((request) => request.requestId === requestId),
  );
}

/**
 * The held turn moves on, steered: the sign-ins it waits on are withdrawn, including a
 * responder's for one of its approvals.
 */
export function withdrawSignIns(view: SessionView, reason: string): Transition {
  const tables = publicViewOf(view.projection);
  return {
    events: view.signIns.flatMap((challenge) => {
      const interactionId = signInInteractionId(challenge);
      return tables.interactions[interactionId]?.status === "open"
        ? [interactionSettled(interactionId, "withdrawn", { reason })]
        : [];
    }),
    signIns: [],
    turn: view.turn,
  };
}

// ---------------------------------------------------------------------------
// requestLimit
// ---------------------------------------------------------------------------

/**
 * The session spent its budget: it asks whether to continue instead of calling the model, and
 * the turn pauses on the prompt. `answer` grants a fresh budget or declines it.
 */
export function requestLimit(
  view: SessionView,
  input: { readonly request: InputRequest },
): Transition {
  const { turnId } = turnPosition(view.projection);
  const opened = interactionOpened(input.request, { scope: { turnId } });
  return {
    events: [opened, ...hold(view, { on: "input", opening: [input.request.requestId] }).events],
    turn: view.turn,
  };
}

// ---------------------------------------------------------------------------
// requireSignIn
// ---------------------------------------------------------------------------

/**
 * Work needs a sign-in. The calls that need it stop, settling `cancelled` until it completes;
 * an attempt it replaces fails; and each sign-in is asked for and recorded. The turn holds until
 * every sign-in calls back. Input that waited on a responder's sign-in stays queued for it. An
 * approved call that needs the sign-in leaves its step, so the model calls it again once the
 * sign-in completes.
 */
export function requireSignIn(
  view: SessionView,
  input: {
    readonly challenges: readonly AuthorizationChallenge[];
    readonly callIdsByName?: ReadonlyMap<string, readonly string[]>;
    readonly queued?: StepInput;
  },
): Transition {
  const { turnId } = turnPosition(view.projection);
  const tables = publicViewOf(view.projection);
  const opening = input.challenges.filter(
    (challenge) => tables.interactions[signInInteractionId(challenge)] === undefined,
  );
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
  events.push(
    ...hold(view, {
      on: "input",
      opening: opening.map((challenge) => signInInteractionId(challenge)),
    }).events,
  );
  const queued =
    input.queued === undefined
      ? view.turn.queued
      : view.turn.queued === undefined
        ? input.queued
        : coalesceTurnInputs(view.turn.queued, input.queued);
  const signIns = withSignIns(view.signIns, input.challenges);
  const stopped = new Set([...(input.callIdsByName?.values() ?? [])].flat());
  const suspended = view.turn.suspended.map((step) =>
    [...stepCallIds(step)].some((callId) => stopped.has(callId))
      ? { ...step, messages: withoutCalls(step.messages, stopped) }
      : step,
  );
  if (suspended.every((step, index) => step === view.turn.suspended[index])) {
    return { events, signIns, turn: { ...view.turn, queued } };
  }
  const settled = settle({ ...view, turn: { ...view.turn, queued, suspended } }, { results: [] });
  return { commit: settled.commit, events, signIns, turn: settled.turn };
}
