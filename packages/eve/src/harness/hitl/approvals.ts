import type { SessionEvent } from "#protocol/session-event.js";
import type { ModelMessage } from "ai";

import type { ResponderCheck } from "./responders.js";
import type { AuthorizationChallenge } from "#harness/authorization.js";
import { supersededChallenges, withSignIns } from "./sign-ins.js";
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
import { openRequests, SUPERSEDED_BY_MESSAGE } from "#protocol/session-reader.js";
import type { InteractionOutcome } from "#protocol/session-events/families/interaction.js";
import type { ResponseOutcome } from "#protocol/session-events/families/response.js";
import type {
  InteractionRow,
  ResponseRow,
  SessionView as PublicView,
} from "#protocol/session-projection/tables.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import type { Answer } from "#shared/input.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { Transition } from "#harness/session-machine/commit.js";
import { isEmptyInput, type ResolvedStepInput } from "./delivery.js";
import type {
  ApprovalAsk,
  StepCoordinates,
  SuspendedStep,
  TurnState,
} from "#harness/session-machine/view.js";
import { withoutCalls } from "#harness/inline-tool-authorization.js";
import { settle } from "#harness/session-machine/transitions.js";
import { stepCallIds, suspend, withResult } from "#harness/session-machine/suspended-steps.js";
import { ownOpenRequestIds } from "#harness/session-machine/view.js";
import { runningTasks, turnPosition, type SessionView } from "#harness/session-machine/view.js";

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
    return tasks.length === 0 ? step : { ...step, tasks: [...step.tasks, ...tasks] };
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
  const refused: SessionEvent[] =
    check.refused.length === 0
      ? []
      : (delivery?.deliveries ?? []).map(({ deliveryId }) => ({
          data: { deliveryId, outcome: "refused", reason: refusal },
          type: "delivery.settled",
        }));
  return {
    events: [...responses.facts(), ...refused],
    responders: { upsert: check.weigh },
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

/** A call a person approved, with the step that asked, which it runs with. */
export interface ApprovedCall {
  readonly request: ApprovalAsk;
  readonly step: SuspendedStep;
  /** Who approved it, when a response policy allowed their answer; the call reads it. */
  readonly responder?: SessionAuthContext;
}

/**
 * A step's approvals settle together, once each has a standing answer. A message steers past
 * them instead: the answers given stand, and the approvals nobody answered are withdrawn.
 * Approved calls are returned to run; denied ones get their denial as a result, and `once()`
 * approvals grant their key. `answered` says a step settled on its answers rather than a message.
 */
export function settleApprovals(
  view: SessionView,
  input: {
    readonly steer: boolean;
    readonly approvalKey: (request: ApprovalAsk) => string | undefined;
  },
): Transition & { readonly approved: readonly ApprovedCall[]; readonly answered: boolean } {
  const tables = view.projection.view;
  const standing = standingAnswers(tables);
  const answerOf = (request: ApprovalAsk) =>
    responseOf(request.interactionId, standing.get(request.interactionId));
  const responses = responseLedger(tables);
  const grants = new Set(view.turn.grants);
  const approved: ApprovedCall[] = [];
  let answered = false;
  const events: SessionEvent[] = [];
  const decide = (request: ApprovalAsk, outcome: InteractionOutcome, reason?: string) => {
    const answer = outcome === "withdrawn" ? undefined : standing.get(request.interactionId);
    if (answer !== undefined) responses.settle(answer.responseId, "applied");
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
        grants.add(input.approvalKey(request) ?? toolName);
        const responder = view.responders[standing.get(request.interactionId)?.responseId ?? ""];
        approved.push({
          request,
          step,
          ...(responder !== undefined && { responder: responder.responder }),
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
  return {
    answered,
    approved,
    events: [...responses.facts(), ...events],
    turn: { ...view.turn, grants: [...grants], suspended },
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

/** Keys `once()` approvals granted, except those a pending approval still asks about. */
export function grantedApprovalKeys(
  view: SessionView,
  approvalKey: (request: ApprovalAsk) => string | undefined,
): ReadonlySet<string> {
  const granted = new Set(view.turn.grants);
  for (const step of view.turn.suspended) {
    for (const request of pendingApprovals(view, step))
      granted.delete(approvalKey(request) ?? request.call.toolName);
  }
  return granted;
}

/** The suspended step that holds `interactionId`. */
export function stepForRequest(
  view: SessionView,
  interactionId: string,
): SuspendedStep | undefined {
  return view.turn.suspended.find((step) =>
    step.requests.some((request) => request.interactionId === interactionId),
  );
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
 * responder's for one of its approvals.
 */
export function withdrawSignIns(view: SessionView, reason: string): Transition {
  const tables = view.projection.view;
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

/**
 * Work needs a sign-in. The calls that need it stop, settling `cancelled` until it completes;
 * an attempt it replaces fails; and each sign-in is asked for and recorded. Input that waited on
 * a responder's sign-in stays queued for it. An approved call that needs the sign-in leaves its
 * step, so the model calls it again once the sign-in completes.
 */
export function requireSignIn(
  view: SessionView,
  input: {
    readonly challenges: readonly AuthorizationChallenge[];
    readonly callIdsByName?: ReadonlyMap<string, readonly string[]>;
    readonly queued?: HarnessStepInput;
  },
): Transition {
  const { turnId } = turnPosition(view.projection);
  const tables = view.projection.view;
  const opening = input.challenges.filter(
    (challenge) => tables.interactions[signInInteractionId(challenge)] === undefined,
  );
  const stopped = new Set([...(input.callIdsByName?.values() ?? [])].flat());
  const events: SessionEvent[] = [
    // A call a sign-in stopped leaves its step: it settles here, and the model calls it again,
    // under a new call, once the sign-in completes.
    ...[...stopped].flatMap((callId): SessionEvent[] => {
      const call = tables.calls[callId];
      if (call === undefined || call.status === "settled") return [];
      return [
        {
          data: { callId, outcome: "interrupted", reason: "authorization-required" },
          type: "call.settled",
        },
      ];
    }),
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
  const suspended = turn.suspended.map((step) =>
    [...stepCallIds(step)].some((callId) => stopped.has(callId))
      ? { ...step, messages: withoutCalls(step.messages, stopped) }
      : step,
  );
  if (suspended.every((step, index) => step === turn.suspended[index])) {
    return { events, signIns, turn };
  }
  const settled = settle({ ...view, turn: { ...turn, suspended } }, { results: [] });
  return { commit: settled.commit, events, signIns, turn: settled.turn };
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
