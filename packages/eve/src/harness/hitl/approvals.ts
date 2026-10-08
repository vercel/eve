import type { SessionAuthContext } from "#channel/types.js";
import type { ModelMessage } from "ai";

import type { getApprovalAuditState } from "#harness/hitl/candidates.js";
import {
  supersededChallenges,
  withSignIns,
  type AuthorizationChallenge,
} from "#harness/authorization.js";
import { authorizationEventFields } from "#harness/authorization-event-fields.js";
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
import {
  createActionResultEvent,
  createApprovalCandidateEvent,
  createApprovalSettledEvent,
  createAuthorizationCompletedEvent,
  createAuthorizationRequiredEvent,
  createInputRequestedEvent,
  createInputResolvedEvent,
  createMessageCompletedEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import {
  openInputs,
  turnCoordinates,
  type SessionProjection,
} from "#protocol/session-projection.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import type { InputRequest } from "#shared/input.js";
import type { Transition } from "#harness/session-machine/commit.js";
import { signInWithdrawn } from "#harness/session-machine/events.js";
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
  finishTurn,
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
        : [createInputRequestedEvent({ requests: input.requests, ...input.event })],
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
    readonly approvalKey: (request: InputRequest) => string | undefined;
    /** Whether the agent has `eve__search`, which a call whose tool is gone can use to find another. */
    readonly searchable: boolean;
  },
): Answered {
  const { policy } = input;
  const { projection } = view;
  const position = turnPosition(projection);
  const events: UnstampedMessageStreamEvent[] = [
    ...policy.feedback.map((message) =>
      createMessageCompletedEvent({
        message,
        sequence: position.sequence,
        stepIndex: position.stepIndex,
        turnId: position.turnId,
      }),
    ),
    ...reportApprovalProgress(projection, policy.audit, policy.challengesAtStart),
  ];
  let turn: TurnState = input.takeQueued ? { ...view.turn, queued: undefined } : view.turn;
  const done = (answered: Omit<Answered, "events" | "turn" | "resolved"> & Partial<Answered>) =>
    ({ events, resolved: [], turn, ...answered }) satisfies Answered;
  const queue = (queued: StepInput | undefined) => {
    turn = withQueued(turn, queued);
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
  const responses = canonicalize(resolved?.inputResponses ?? []);
  const byId = new Map(responses.map((response) => [response.requestId, response]));
  const answered = answerable.filter((step) =>
    step.requests.every((request) => byId.has(request.requestId)),
  );
  const leftoverFor = (steps: readonly SuspendedStep[]) =>
    responses.filter((response) =>
      steps.some((step) =>
        step.requests.some((request) => request.requestId === response.requestId),
      ),
    );
  // Nothing runs: the input waits, and the held turn stays held.
  const park = () => {
    queue(compactInput(resolved));
    return done({ next: "park" });
  };
  if (responses.length === 0 && resolved?.message === undefined) return park();

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
    events.push(resolvedEvent(batch));
    const leftover = leftoverFor(answerable);
    if (leftover.length > 0) queue({ inputResponses: leftover });
    return done({
      consumedMessage: resolved?.messageConsumed,
      input: withoutResponses(resolved),
      limit: resolveSessionLimitContinuation({ requests: [limit.request], responses }),
      next: "continue",
      resolved: [batch],
    });
  }

  if (answered.length === 0 && resolved?.message === undefined) return park();
  // A message steers the held turn past its first pending batch: the answers it has stand, and
  // the requests nobody answered are ignored. Later batches stay open.
  if (answered.length === 0) answered.push(answerable[0]!);
  const leftover = leftoverFor(answerable.filter((step) => !answered.includes(step)));
  if (leftover.length > 0) queue({ inputResponses: leftover });

  const grants = new Set(turn.grants);
  const batches: ResolvedInputBatch[] = [];
  const results: UnstampedMessageStreamEvent[] = [];
  const unavailable = new Set(
    policy.audit.settlements
      .filter((settlement) => settlement.outcome === "unavailable")
      .map((settlement) => settlement.requestId),
  );
  const suspended = turn.suspended.map((step) => {
    if (!answered.includes(step)) return step;
    let messages = step.messages;
    const approvedRequests: InputRequest[] = [];
    for (const request of step.requests) {
      const { callId, toolName } = request.action;
      if (unavailable.has(request.requestId)) {
        const failed = failedCall({
          callId,
          message: unavailableToolMessage(toolName, input.searchable),
          toolName,
        });
        messages = withResult(messages, failed.part);
        results.push(createActionResultEvent({ result: failed.result, ...step.event }));
        continue;
      }
      const { approved, reason, status } = resolveApprovalOutcome(byId.get(request.requestId));
      if (approved) {
        grants.add(input.approvalKey(request) ?? toolName);
        approvedRequests.push(request);
        continue;
      }
      messages = withResult(messages, {
        output: { reason, type: "execution-denied" },
        toolCallId: callId,
        toolName,
        type: "tool-result",
      });
      results.push(
        createActionResultEvent({
          rejected: true,
          result: {
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
          ...step.event,
        }),
      );
    }
    batches.push({
      event: step.event,
      inputs: step.requests.map((request) => {
        const response = byId.get(request.requestId);
        return { outcome: resolveInputOutcome(request.kind, response), request, response };
      }),
    });
    const approved = [...(step.approved ?? []), ...approvedRequests];
    return { ...step, messages, requests: [], ...(approved.length > 0 && { approved }) };
  });
  events.push(...batches.map(resolvedEvent), ...results);
  turn = { ...turn, grants: [...grants], suspended };
  return done({
    consumedMessage: resolved?.messageConsumed,
    input: withoutResponses(resolved),
    next: "continue",
    resolved: batches,
  });
}

/** The `input.resolved` for a batch, at the coordinates of the step that asked. */
function resolvedEvent(batch: ResolvedInputBatch): UnstampedMessageStreamEvent {
  return createInputResolvedEvent({
    resolutions: batch.inputs.map((resolved) => {
      const resolution = {
        kind: resolved.request.kind,
        outcome: resolved.outcome,
        requestId: resolved.request.requestId,
      };
      return resolved.response === undefined
        ? resolution
        : { ...resolution, response: resolved.response };
    }),
    ...batch.event,
  });
}

/**
 * Responder progress on approvals: candidates that started or finished, approvals they settled,
 * and the sign-in of a candidate that expired. Each is reported once, when the projection hasn't
 * heard it, for requests the projection still holds.
 */
function reportApprovalProgress(
  projection: SessionProjection,
  audit: ReturnType<typeof getApprovalAuditState>,
  challenges: readonly AuthorizationChallenge[],
): readonly UnstampedMessageStreamEvent[] {
  const at = turnCoordinates(projection);
  const isOpen = (requestId: string) => {
    const open = projection.inputs[requestId];
    return open !== undefined && open.status !== "settled";
  };
  const events: UnstampedMessageStreamEvent[] = [];
  for (const challenge of challenges) {
    const expired = audit.candidateHistory.some(
      (candidate) =>
        candidate.candidateId === challenge.candidateId && candidate.status === "timed-out",
    );
    const attempt = projection.authorizations[challenge.attemptId ?? challenge.name];
    if (!expired || attempt?.status !== "required") continue;
    events.push(
      createAuthorizationCompletedEvent({
        ...authorizationEventFields(challenge),
        outcome: "failed",
        reason: "The approval response expired. Please submit a new response.",
        ...at,
      }),
    );
  }
  for (const candidate of audit.activeCandidates) {
    if (projection.candidates[candidate.candidateId] !== undefined) continue;
    if (!isOpen(candidate.requestId)) continue;
    events.push(
      createApprovalCandidateEvent({
        candidateId: candidate.candidateId,
        outcome: "pending",
        requestId: candidate.requestId,
        responderPrincipalId: candidate.responder.principalId,
        ...at,
      }),
    );
  }
  for (const candidate of audit.candidateHistory) {
    if (candidate.status === "allowed" || candidate.status === "authorization-required") continue;
    if (projection.inputs[candidate.requestId] === undefined) continue;
    if (projection.candidates[candidate.candidateId]?.outcome === candidate.status) continue;
    events.push(
      createApprovalCandidateEvent({
        candidateId: candidate.candidateId,
        outcome: candidate.status,
        requestId: candidate.requestId,
        responderPrincipalId: candidate.responder.principalId,
        reason: candidate.reason,
        ...at,
      }),
    );
  }
  for (const settlement of audit.settlements) {
    // An unavailable request's candidate reported it failed, with the reason.
    if (!isOpen(settlement.requestId) || settlement.outcome === "unavailable") continue;
    events.push(
      createApprovalSettledEvent({
        outcome: settlement.outcome === "allowed" ? "approved" : "cancelled",
        requestId: settlement.requestId,
        responderPrincipalId: settlement.actor.principalId,
        ...at,
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
 * The held turn moves on, steered or cancelled: the sign-ins it waits on end, declined, including
 * a responder's for one of its approvals.
 */
export function withdrawSignIns(view: SessionView, reason: string): Transition {
  return {
    events: view.signIns.flatMap((challenge) => {
      const attempt = view.projection.authorizations[challenge.attemptId ?? challenge.name];
      return attempt?.status === "required" ? [signInWithdrawn(attempt, reason)] : [];
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
 * the turn ends. The prompt is the projection's open request; `answer` grants a
 * fresh budget or declines it.
 */
export function requestLimit(
  view: SessionView,
  input: { readonly request: InputRequest },
): Transition {
  const position = turnPosition(view.projection);
  return {
    events: [
      createInputRequestedEvent({
        requests: [input.request],
        sequence: position.sequence,
        stepIndex: position.stepIndex,
        turnId: position.turnId,
      }),
      ...finishTurn(view).events,
    ],
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
  const position = turnPosition(view.projection);
  const at = {
    sequence: position.sequence,
    stepIndex: position.stepIndex,
    turnId: position.turnId,
  };
  const events: UnstampedMessageStreamEvent[] = [
    ...supersededChallenges(view.signIns, input.challenges).map((superseded) =>
      createAuthorizationCompletedEvent({
        ...authorizationEventFields(superseded),
        outcome: "failed",
        reason: "Superseded by a newer authorization attempt.",
        ...at,
      }),
    ),
    ...input.challenges.map((challenge) =>
      createAuthorizationRequiredEvent({
        ...authorizationEventFields(challenge),
        description:
          challenge.challenge.instructions ?? `Authorization required for ${challenge.name}`,
        webhookUrl: challenge.hookUrl,
        ...at,
      }),
    ),
  ];
  events.push(...hold(view, { on: "input" }).events);
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
