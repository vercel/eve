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
import { responseLedger, responseOf, standingAnswers } from "./responses.js";
import type { HarnessStepInput } from "#harness/types.js";
import { callSettledFrom } from "#harness/call-facts.js";
import {
  approvalOpened,
  interactionSettled,
  signInInteractionId,
  signInOpened,
} from "#harness/interaction-facts.js";
import { SUPERSEDED_BY_MESSAGE } from "#protocol/session-projection/reader.js";
import type { InteractionOutcome } from "#protocol/session-events/families/interaction.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
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
import { runningTasks, turnPosition, type SessionView } from "#harness/session-machine/view.js";

// The session's human-in-the-loop rules. Each reads the session and returns what changed; the
// step runs them in order and parks once, when none of them leaves anything to run.
//
// A model step asks for the approvals its calls need (`askApprovals`). Answers are admitted as
// they arrive and stand, revisable, as response rows (`admitAnswers`); a step's approvals settle
// together once each has one, or when a message steers past them (`settleApprovals`). An
// exhausted budget asks to continue (see `budget.ts`), and a sign-in stops the
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
  // Only the deliveries that carried a refused answer, and haven't settled already, are refused.
  const refused: SessionEvent[] = [...refusedDeliveries(check, delivery)]
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

export function refusedDeliveries(
  check: ResponderCheck,
  delivery: ResolvedStepInput | undefined,
): ReadonlySet<string> {
  const refused = new Set(check.refused.map(({ responseId }) => responseId));
  return new Set(
    (delivery?.answers ?? []).flatMap((answer) =>
      refused.has(answer.responseId) && answer.deliveryId !== undefined ? [answer.deliveryId] : [],
    ),
  );
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
