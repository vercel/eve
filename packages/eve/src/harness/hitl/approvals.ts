import type { SessionEvent } from "#protocol/session-event.js";
import type { ModelMessage } from "ai";
import {
  type ApprovalMemory,
  type RememberedApproval,
  rememberDecision,
} from "#approval/evaluation.js";

import type { ResponderCheck } from "./responders.js";
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
import type { HarnessStepInput, SubmittedAnswer } from "#harness/types.js";
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
import { interactionOwner } from "#protocol/session-projection/selectors.js";
import { openRequests, SUPERSEDED_BY_MESSAGE } from "#protocol/session-projection/reader.js";
import type { InteractionOutcome } from "#protocol/session-events/families/interaction.js";
import type { ResponseOutcome } from "#protocol/session-events/families/response.js";
import type {
  InteractionRow,
  ResponseRow,
  SessionView as PublicView,
} from "#protocol/session-projection/tables.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import type { Answer } from "#shared/input.js";
import type { Transition } from "#harness/session-machine/commit.js";
import { isEmptyInput, type ResolvedStepInput } from "./delivery.js";
import type {
  ApprovalAsk,
  ApprovedCall,
  StepCoordinates,
  SuspendedStep,
  TurnState,
} from "#harness/session-machine/view.js";
import {
  awaitSignIns,
  runnableCalls,
  settle,
  withoutApproved,
} from "#harness/session-machine/transitions.js";
import { stepCallIds, suspend, withResult } from "#harness/session-machine/suspended-steps.js";
import {
  ownOpenRequestIds,
  runningTasks,
  turnPosition,
  type SessionView,
} from "#harness/session-machine/view.js";

// The session's human-in-the-loop rules. Each reads the session and returns what changed; the
// step runs them in order and parks once, when none of them leaves anything to run.
//
// A model step asks for the approvals its calls need (`askApprovals`). Answers are admitted as
// they arrive and stand, revisable, as response rows (`admitAnswers`); a step's approvals settle
// together once each has one, or when a message steers past them (`settleApprovals`). An
// exhausted budget asks to continue (`requestLimit`, `settleLimit`), and a sign-in stops the
// calls that need it (`requireSignIn`). Nothing here pauses the turn: the step does, from what
// is still open.

// ---------------------------------------------------------------------------
// Asking
// ---------------------------------------------------------------------------

/**
 * A model response made calls that need a person's approval. The response waits in a suspended
 * step, beside any runtime calls it made. The approvals are asked now, or once the step's tasks
 * finish (`openDeferredApprovals`).
 */
export function askApprovals(
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
    events: input.tasks.length > 0 ? [] : input.requests.map((ask) => approvalOpened(ask)),
    turn,
  };
}

/** A step that parked approvals beside its tasks asks for them once the tasks finish. */
export function openDeferredApprovals(view: SessionView): Transition {
  const tables = view.projection.view;
  const events = view.turn.suspended.flatMap((step) =>
    step.tasks.length === 0 ||
    runningTasks(step).length > 0 ||
    step.requests.some((request) => tables.interactions[request.interactionId] !== undefined)
      ? []
      : step.requests.map((ask) => approvalOpened(ask)),
  );
  return { events, turn: view.turn };
}

/** The step's approvals nobody has settled: open, or not asked yet. */
export function pendingApprovals(view: SessionView, step: SuspendedStep): readonly ApprovalAsk[] {
  const tables = view.projection.view;
  return step.requests.filter((request) => {
    const row = tables.interactions[request.interactionId];
    return row === undefined || row.status === "open";
  });
}

/** Approved workflow and agent calls join the runs their requesting steps wait on. */
export function dispatch(
  view: SessionView,
  input: { readonly tasks: readonly RuntimeWorkflowTaskRequest[] },
): Transition {
  const suspended = view.turn.suspended.map((step) => {
    const calls = stepCallIds(step);
    const tasks = input.tasks.filter((task) => calls.has(task.callId));
    if (tasks.length === 0) return step;
    const dispatched = withoutApproved(step, new Set(tasks.map((task) => task.callId)));
    return { ...dispatched, tasks: [...step.tasks, ...tasks] };
  });
  return { events: [], turn: { ...view.turn, suspended } };
}

/** Turn input the turn can't take yet waits, unreceived, for a later step. */
export function queueInput(view: SessionView, input: HarnessStepInput | undefined): Transition {
  return { events: [], turn: withQueued(view.turn, input) };
}

function withQueued(turn: TurnState, queued: HarnessStepInput | undefined): TurnState {
  if (queued === undefined || isEmptyInput(queued)) return turn;
  return {
    ...turn,
    queued: turn.queued === undefined ? queued : coalesceTurnInputs(turn.queued, queued),
  };
}

// ---------------------------------------------------------------------------
// Admitting answers
// ---------------------------------------------------------------------------

/**
 * A delivery's answers reach the session: each is submitted once, and stands, admitted, once
 * its responder may answer. An answer a response policy still weighs stays submitted. What a
 * responder may not do refuses their delivery, with why.
 */
export function admitAnswers(
  view: SessionView,
  input: {
    readonly delivery: ResolvedStepInput | undefined;
    readonly check: ResponderCheck;
  },
): Transition {
  const { check, delivery } = input;
  const tables = view.projection.view;
  const responses = responseLedger(tables);
  responses.submit(delivery?.answers ?? []);
  for (const { reason, responseId } of check.refused) {
    if (responseId !== undefined) responses.settle(responseId, "refused", reason);
  }
  for (const responseId of check.admit) responses.admit(responseId);
  const refusal = check.refused.map(({ reason }) => reason).join("\n");
  // The step's input can join an earlier delivery whose answer waits for the rest of its batch:
  // only the deliveries that carried a refused answer, and haven't settled, are refused.
  const refusedIds = new Set(check.refused.map(({ responseId }) => responseId));
  const carriers = (delivery?.answers ?? [])
    .filter(({ responseId }) => refusedIds.has(responseId))
    .map(({ deliveryId }) => deliveryId);
  const traced =
    carriers.length === check.refused.length && carriers.every((id) => id !== undefined);
  const refusedDeliveries = new Set(
    traced ? carriers : (delivery?.deliveries ?? []).map(({ deliveryId }) => deliveryId),
  );
  const refused: SessionEvent[] = [...refusedDeliveries]
    .filter((deliveryId) => tables.deliveries[deliveryId]?.status !== "settled")
    .map((deliveryId) => ({
      data: { deliveryId, outcome: "refused", reason: refusal },
      type: "delivery.settled",
    }));
  return {
    events: [...responses.facts(), ...refused],
    responders: check.weigh,
    turn: view.turn,
  };
}

/** The answer that stands for each open interaction: its latest admitted response. */
function standingAnswers(tables: PublicView): ReadonlyMap<string, ResponseRow> {
  const standing = new Map<string, ResponseRow>();
  const rows = Object.values(tables.responses).sort((a, b) => a.introducedAt - b.introducedAt);
  for (const row of rows) {
    if (row.status === "admitted") standing.set(row.interactionId, row);
  }
  return standing;
}

function responseOf(interactionId: string, row: ResponseRow | undefined): Answer | undefined {
  if (row?.value === undefined) return undefined;
  const response: { interactionId: string; optionId?: string; text?: string } = { interactionId };
  if (row.value.optionId !== undefined) response.optionId = row.value.optionId;
  if (row.value.text !== undefined) response.text = row.value.text;
  return response;
}

// ---------------------------------------------------------------------------
// Settling approvals
// ---------------------------------------------------------------------------

/** A call cleared to run now, with the step that asked, whose tools it runs with. */
export interface RunnableCall {
  readonly approval: ApprovedCall;
  readonly step: SuspendedStep;
}

/**
 * A step's approvals settle together, once each has a standing answer. A message steers past
 * them instead: the answers given stand, and the approvals nobody answered are withdrawn.
 * Approved calls are returned to run; denied ones get their denial as a result.
 * A request that asked to be remembered records the decision. `answered` says a step settled on
 * its answers rather than a message.
 */
export function settleApprovals(
  view: SessionView,
  input: {
    readonly steer: boolean;
  },
): Transition & { readonly approved: readonly RunnableCall[]; readonly answered: boolean } {
  const tables = view.projection.view;
  const standing = standingAnswers(tables);
  const answerOf = (request: ApprovalAsk) =>
    responseOf(request.interactionId, standing.get(request.interactionId));
  const responses = responseLedger(tables);
  const approved: RunnableCall[] = [];
  let answered = false;
  const events: SessionEvent[] = [];
  const decisions: {
    readonly at: number;
    readonly request: ApprovalAsk;
    readonly outcome: RememberedApproval["outcome"];
  }[] = [];
  const decide = (request: ApprovalAsk, outcome: InteractionOutcome, reason?: string) => {
    const answer = outcome === "withdrawn" ? undefined : standing.get(request.interactionId);
    if (answer !== undefined) responses.settle(answer.responseId, "applied");
    if (answer !== undefined && (outcome === "accepted" || outcome === "declined"))
      decisions.push({ at: answer.introducedAt, outcome, request });
    responses.closeOthers(request.interactionId, answer?.responseId);
    events.push(
      interactionSettled(request.interactionId, outcome, {
        cause: answer === undefined ? undefined : { responseId: answer.responseId },
        reason,
        response: outcome === "withdrawn" ? undefined : answerOf(request),
      }),
    );
  };
  const suspended = view.turn.suspended.map((step) => {
    const pending = pendingApprovals(view, step).filter(
      (request) => tables.interactions[request.interactionId] !== undefined,
    );
    if (pending.length === 0) return step;
    const complete = pending.every((request) => answerOf(request) !== undefined);
    if (!input.steer && !complete) return step;
    answered ||= complete;
    let messages = step.messages;
    for (const request of pending) {
      const { callId, toolName } = request.call;
      const { approved: approves, reason, status } = resolveApprovalOutcome(answerOf(request));
      if (approves) {
        const responder = view.responders[standing.get(request.interactionId)?.responseId ?? ""];
        approved.push({
          approval: {
            call: request.call,
            interactionId: request.interactionId,
            ...(responder !== undefined && { responder: responder.responder }),
          },
          step,
        });
        decide(request, "accepted");
        continue;
      }
      if (status === "ignored") decide(request, "withdrawn", SUPERSEDED_BY_MESSAGE);
      else decide(request, status === "invalid" ? "invalid" : "declined");
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
            approval: { interactionId: request.interactionId, status },
            code: "TOOL_EXECUTION_DENIED",
            message: reason ?? TOOL_EXECUTION_DENIED_MESSAGE,
            tool: { result: "not_run" },
          },
          toolName,
        },
        { rejected: true },
      );
      events.push({
        ...settled,
        data: { ...settled.data, cause: { interactionId: request.interactionId } },
      });
    }
    return { ...step, messages };
  });
  // Decisions settled together apply in the order people gave them, and the latest one stands.
  // Answers in one delivery share a position and can't be ordered, so a denial among them stands.
  const declinedLast = (decision: (typeof decisions)[number]) =>
    decision.outcome === "declined" ? 1 : 0;
  const remembered = decisions
    .sort((a, b) => a.at - b.at || declinedLast(a) - declinedLast(b))
    .reduce(
      (memory, decision) => rememberDecision(memory, decision.request, decision.outcome),
      view.turn.remembered,
    );
  return {
    answered,
    approved,
    events: [...responses.facts(), ...events],
    turn: { ...view.turn, remembered, suspended },
  };
}

/**
 * Approvals whose tool went away: no answer can run their calls, so nobody needs them anymore.
 * Each call fails, and the model reads why.
 */
export function withdrawUnavailable(
  view: SessionView,
  input: {
    readonly interactionIds: readonly string[];
    readonly searchable: (request: ApprovalAsk) => boolean;
  },
): Transition {
  const tables = view.projection.view;
  const responses = responseLedger(tables);
  const gone = new Set(input.interactionIds);
  const events: SessionEvent[] = [];
  const suspended = view.turn.suspended.map((step) => {
    let messages = step.messages;
    for (const request of pendingApprovals(view, step)) {
      if (!gone.has(request.interactionId)) continue;
      const { callId, toolName } = request.call;
      const message = unavailableToolMessage(toolName, input.searchable(request));
      const failed = failedCall({ callId, message, toolName });
      messages = withResult(messages, failed.part);
      responses.closeOthers(request.interactionId, undefined);
      events.push(
        interactionSettled(request.interactionId, "withdrawn", { reason: message }),
        callSettledFrom(failed.result),
      );
    }
    return messages === step.messages ? step : { ...step, messages };
  });
  return { events: [...responses.facts(), ...events], turn: { ...view.turn, suspended } };
}

export function approvalMemory(view: SessionView): ApprovalMemory {
  return {
    pending: view.turn.suspended.flatMap((step) =>
      pendingApprovals(view, step).flatMap((request) =>
        request.remember === undefined ? [] : [request.remember.key],
      ),
    ),
    remembered: view.turn.remembered,
  };
}

// ---------------------------------------------------------------------------
// The budget prompt
// ---------------------------------------------------------------------------

/** Why an answer to the budget prompt that is neither Continue nor Stop doesn't count. */
const INVALID_BUDGET_ANSWER = "The budget prompt takes Continue or Stop.";

/** The budget prompt the session waits on, with the turn it asked in, if any. */
export function openLimit(
  view: SessionView,
): { readonly row: InteractionRow; readonly turnId?: string } | undefined {
  const own = ownOpenRequestIds(view);
  const tables = view.projection.view;
  const row = openRequests(tables).find(
    (open) => open.request.kind === "budget" && own.has(open.interactionId),
  );
  return row === undefined ? undefined : { row, turnId: interactionOwner(tables, row).turnId };
}

/**
 * The session spent its budget: it asks whether to continue instead of calling the model.
 * `settleLimit` grants a fresh budget or declines it.
 */
export function requestLimit(view: SessionView, ask: LimitAsk): Transition {
  const { turnId } = turnPosition(view.projection);
  return {
    events: [interactionOpened({ ...ask, subject: { turnId } })],
    turn: view.turn,
  };
}

/**
 * The budget prompt settles on its standing answer: Continue grants a fresh budget, and Stop
 * declines it. Any other answer is refused, and the prompt stays open for another.
 */
export function settleLimit(view: SessionView): Transition & {
  readonly limit?: { readonly granted: boolean };
} {
  const open = openLimit(view);
  const tables = view.projection.view;
  const interactionId = open?.row.interactionId;
  const answer =
    interactionId === undefined ? undefined : standingAnswers(tables).get(interactionId);
  const response = interactionId === undefined ? undefined : responseOf(interactionId, answer);
  if (
    open === undefined ||
    interactionId === undefined ||
    answer === undefined ||
    response === undefined
  )
    return { events: [], turn: view.turn };
  const responses = responseLedger(tables);
  const granted = limitDecision(response);
  if (granted === undefined) {
    responses.settle(answer.responseId, "refused", INVALID_BUDGET_ANSWER);
    return { events: responses.facts(), turn: view.turn };
  }
  responses.settle(answer.responseId, "applied");
  responses.closeOthers(interactionId, answer.responseId);
  return {
    events: [
      ...responses.facts(),
      interactionSettled(interactionId, granted.granted ? "accepted" : "declined", {
        cause: { responseId: answer.responseId },
        response,
      }),
    ],
    limit: granted,
    turn: view.turn,
  };
}

// ---------------------------------------------------------------------------
// Sign-ins
// ---------------------------------------------------------------------------

/**
 * The held turn moves on, steered: the sign-ins it waits on are withdrawn, including a
 * responder's for one of its approvals, and the calls that waited for them fail with `reason`.
 */
export function withdrawSignIns(view: SessionView, reason: string): Transition {
  const tables = view.projection.view;
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
  const tables = view.projection.view;
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
        // A responder's sign-in is about their answer; any other holds the turn.
        subject:
          challenge.candidateId !== undefined &&
          tables.responses[challenge.candidateId] !== undefined
            ? { responseId: challenge.candidateId }
            : { turnId },
      }),
    ),
  ];
  const turn = withQueued(view.turn, input.queued);
  const signIns = withSignIns(view.signIns, input.challenges);
  const { calls } = input;
  const suspended =
    calls === undefined
      ? turn.suspended
      : turn.suspended.map((step) =>
          awaitSignIns(step, { challenges: input.challenges, stopped: calls }),
        );
  return { events, signIns, turn: { ...turn, suspended } };
}

// ---------------------------------------------------------------------------
// The response ledger
// ---------------------------------------------------------------------------

/**
 * The responses a commit records: each answer submitted once, its checks, and how it settled.
 * Revising an admitted answer abandons the one it replaces; an interaction that settles
 * withdraws the open answers that didn't decide it.
 */
interface ResponseLedger {
  /** Records answers not seen yet; one to a request nobody can answer anymore is dropped. */
  submit(answers: readonly SubmittedAnswer[]): void;
  admit(responseId: string): void;
  settle(responseId: string, outcome: ResponseOutcome, reason?: string): void;
  /** Settles every other open answer to an interaction that `decidedBy` settles. */
  closeOthers(interactionId: string, decidedBy: string | undefined): void;
  facts(): SessionEvent[];
}

function responseLedger(tables: PublicView): ResponseLedger {
  const facts: SessionEvent[] = [];
  const fresh = new Map<string, SubmittedAnswer>();
  const status = new Map<string, "submitted" | "admitted" | "settled">();
  for (const row of Object.values(tables.responses)) status.set(row.responseId, row.status);
  const submit = (answers: readonly SubmittedAnswer[]) => {
    for (const answer of answers) {
      const { deliveryId, interactionId, optionId, responseId, text } = answer;
      if (status.has(responseId)) continue;
      // An answer to a request nobody can answer anymore introduces nothing: it was converted
      // or dropped before it got here.
      if (tables.interactions[interactionId]?.status !== "open") continue;
      fresh.set(responseId, answer);
      status.set(responseId, "submitted");
      const value: { optionId?: string; text?: string } = {};
      if (optionId !== undefined) value.optionId = optionId;
      if (text !== undefined) value.text = text;
      facts.push(responseSubmitted({ deliveryId, interactionId, responseId, value }));
    }
  };
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
    submit,
    settle,
  };
}
