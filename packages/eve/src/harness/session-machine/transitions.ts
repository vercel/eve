import type { ModelMessage } from "ai";

import type { SubagentInteractionHookPayload } from "#channel/types.js";
import type { AuthorizationChallenge } from "#harness/authorization.js";
import { callSettledFrom } from "#harness/call-facts.js";
import {
  contextStarted,
  controlAdmitted,
  deliveryApplied,
  delegatedUsageFact,
  errorInfoOf,
  fact,
  defined,
  runSettledFacts,
  sessionEndedFacts,
  turnSettled,
} from "#harness/facts.js";
import { closeUnder } from "#harness/session-machine/cascade.js";
import { interruptedCallResult, type InterruptedCall } from "#harness/interrupted-attempt.js";
import { isOpen } from "#protocol/session-projection/tree.js";
import { activeTurn, interactionOwner } from "#protocol/session-projection/selectors.js";
import type {
  RuntimeIdentity,
  TraceContext,
  SessionPredecessor,
} from "#protocol/session-events/families/session.js";
import type { TaskCancelReason } from "#execution/tasks/table.js";
import {
  interactionSettled,
  responseSettled,
  responseAdmitted,
  responseSubmitted,
  signInInteractionId,
} from "#harness/interaction-facts.js";
import type {
  DeliverySource,
  ImportedMessage,
} from "#protocol/session-events/families/delivery.js";
import type { ControlDelivery } from "#harness/types.js";
import type { ResponseSubmittedData } from "#protocol/session-events/families/response.js";
import type { SessionEvent } from "#protocol/session-event.js";
import type { Cause, Principal, UserPart } from "#protocol/session-events/envelope.js";
import type { TokenUsage } from "#shared/token-usage.js";
import type { FactOf } from "#protocol/session-events/facts.js";
import {
  activeTurnIdOf,
  nextChangeId,
  openRunOf,
  type SessionProjection,
} from "#protocol/session-projection.js";
import type { SessionView as PublicView } from "#protocol/session-projection/tables.js";
import type { RuntimeActionResult } from "#shared/action-types.js";
import type { Answer } from "#shared/input.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import type { Transition } from "./commit.js";
import { signInAttemptKey } from "#harness/hitl/sign-ins.js";
import type { Relay, WorkflowAskRoute } from "#harness/hitl/relays.js";
import type { StoppedCall } from "#harness/inline-tool-authorization.js";
import type { ApprovedCall, SuspendedStep, TurnState } from "./state.js";
import { activeTurnId, answeredCallIds, turnPosition, type SessionView } from "./view.js";
import {
  isComplete,
  stepCallIds,
  suspend,
  withResult,
  withoutResults,
  type ToolResultPart,
} from "./suspended-steps.js";

// The session's transitions: what changes when deliveries arrive, results reach their steps, a
// model attempt is discarded, a task starts or ends, a child relays what it asks, answers go back
// to their askers, sign-ins complete, and a turn fails, is cancelled, or is cleared. Each reads a
// `SessionView` and returns the facts that report the change, with the private state that changes
// alongside them (suspended steps, history, sign-ins, relay routes); `step.apply` publishes them
// as one commit and saves the rest. A step that only reports facts applies them directly; the
// shared builders are in `harness/facts.ts`. Approvals, the session-limit prompt, and sign-in
// requests are in `approvals.ts`.
//
// The writer's cascade ends, in the same commit, whatever an ending leaves open. Transitions are
// pure: what they need from effects (model responses, tool results, the requests a session
// relays) arrives in their input.

const unchanged = (view: SessionView, events: readonly SessionEvent[]) => ({
  events,
  turn: view.turn,
});

/** A delivery a turn consumes, with what the person sent: nothing for an answer or context. */
export interface ConsumedDelivery {
  readonly deliveryId: string;
  readonly parts: readonly UserPart[];
  /** Earlier conversation the delivery brought, which its consumption records. */
  readonly history?: readonly ImportedMessage[];
}

/** The turn the next turn follows: the newest, unless a context change chose another or none. */
function followedTurn(projection: SessionProjection): string | null {
  const selection = projection.view.selection;
  if (selection === null) return null;
  return selection?.turnId ?? projection.view.session.latestTurnId ?? null;
}

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

/** The deliveries the session admitted and nothing has consumed or settled yet. */
function waitingDeliveries(
  projection: SessionProjection,
  deliveries: readonly ConsumedDelivery[],
): readonly ConsumedDelivery[] {
  return deliveries.filter(
    ({ deliveryId }) => projection.view?.deliveries[deliveryId]?.status === "admitted",
  );
}

/** A delivery the turn consumes, with what the person sent. */
function consumed(delivery: ConsumedDelivery, turnId: string): SessionEvent {
  return fact("delivery.consumed", {
    deliveryId: delivery.deliveryId,
    history: (delivery.history?.length ?? 0) > 0 ? delivery.history : undefined,
    parts: delivery.parts,
    turnId,
  });
}

/**
 * Deliveries arrive for a turn: the session starts once, a turn opens unless one is open, and
 * each delivery is consumed into it.
 */
export function receive(
  view: SessionView,
  input: {
    readonly deliveries?: readonly ConsumedDelivery[];
    /** What starts the turn when no delivery does. */
    readonly cause?: Cause;
    readonly parent?: { readonly sessionId: string; readonly callId: string };
    /** The session this one replaced, when eve started it in place of a stranded one. */
    readonly predecessor?: SessionPredecessor;
    readonly runtime?: RuntimeIdentity;
    readonly trace?: TraceContext;
  },
): Transition {
  const { projection } = view;
  const position = turnPosition(projection);
  const turnId = activeTurnId(position);
  // Only a delivery still waiting is consumed. One that settled, such as an answer the turn
  // answered for now while it waited for the rest of its batch, or one a policy refused, is not.
  const deliveries = waitingDeliveries(projection, input.deliveries ?? []);
  const first = deliveries[0];
  const cause: Cause =
    first === undefined ? (input.cause ?? { policy: "system" }) : { deliveryId: first.deliveryId };
  const { parent, predecessor, runtime, trace } = input;
  const events: SessionEvent[] = [];
  if (!position.sessionStarted) {
    events.push(fact("session.started", { parent, predecessor, runtime, trace }));
  }
  if (position.turnId === "") {
    events.push(fact("turn.started", { cause, follows: followedTurn(projection), trace, turnId }));
  }
  events.push(...deliveries.map((delivery) => consumed(delivery, turnId)));
  return unchanged(view, events);
}

/**
 * Deliveries join the open turn without opening one, as answers do.
 * Between turns an answer has nothing to join: it took effect, and settles `applied`. A delivery
 * already settled, such as one refused, joins nothing.
 */
export function join(
  view: SessionView,
  input: { readonly deliveries: readonly ConsumedDelivery[] },
): Transition {
  const { projection } = view;
  const open = waitingDeliveries(projection, input.deliveries);
  const turnId = activeTurnIdOf(projection);
  return unchanged(
    view,
    turnId === undefined
      ? open.map(({ deliveryId }) => deliveryApplied(deliveryId))
      : open.map((delivery) => consumed(delivery, turnId)),
  );
}

/**
 * The step failed. A recoverable failure leaves the session for the user to retry; a terminal
 * one ends it.
 */
export function fail(
  view: SessionView,
  failure: {
    readonly code: string;
    readonly details?: JsonObject;
    readonly message: string;
    readonly terminal?: true;
  },
): Transition {
  // The calls a sign-in stopped never run: the model reads that they stopped.
  const stopped = view.turn.suspended.filter((step) => (step.approved?.length ?? 0) > 0);
  const error = errorInfoOf(failure);
  const turnId = activeTurnIdOf(view.projection);
  // A terminal failure ends the session, which ends the turn with it, in one commit.
  const runId = turnId === undefined ? undefined : openRunOf(view.projection, turnId);
  const events = [
    ...(runId === undefined ? [] : runSettledFacts({ runId, outcome: "failed", error })),
    ...(failure.terminal === undefined
      ? turnSettled(view.projection, { error, outcome: "failed" })
      : sessionEndedFacts(view.projection, {
          cause: turnId === undefined ? undefined : { turnId },
          error,
          outcome: "failed",
        })),
  ];
  return { ...commitSteps(view.turn, stopped, cancelledTranscript), events };
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

/** One call's result, ready for its step's transcript. */
export interface SettledCall {
  readonly part: ToolResultPart;
  /** A runtime result, reported at the coordinates of the step that made the call. */
  readonly result?: RuntimeActionResult;
  /** What the agent behind the call spent, which its settlement records. */
  readonly usage?: TokenUsage;
}

/**
 * Results reach the steps that made their calls. A step whose every call now has a result
 * commits to history, where the model reads it.
 */
export function settle(view: SessionView, input: { readonly results: readonly SettledCall[] }) {
  const events: SessionEvent[] = [];
  const steps = [...view.turn.suspended];
  for (const { part, result, usage } of input.results) {
    const index = steps.findIndex((step) => stepCallIds(step).has(part.toolCallId));
    const step = steps[index];
    if (step === undefined) continue;
    steps[index] = withoutApproved(
      { ...step, messages: withResult(step.messages, part) },
      new Set([part.toolCallId]),
    );
    const recorded = result === undefined ? undefined : view.projection.view.calls[result.callId];
    // A call without its row (pruned, or never published) has nothing left to settle or own spend.
    if (
      result !== undefined &&
      recorded !== undefined &&
      recorded.taskId === undefined &&
      recorded.status !== "settled"
    ) {
      // A task's start receipt is model history only. Its public call stays open until the
      // task replies; the reply path publishes its actual settlement and delegated spend.
      events.push(callSettledFrom(result));
      // A child's usage counts once, in the commit that settles its call.
      if (usage !== undefined) events.push(delegatedUsageFact(result.callId, usage));
    }
  }
  const complete = steps.filter(isComplete);
  return { ...commitSteps({ ...view.turn, suspended: steps }, complete), events };
}

/**
 * A model-call attempt ends without its response reaching history, in one commit with the calls
 * it announced. A retry replaces it: eve can't tell whether those calls ran, so they and the run
 * settle `abandoned`. Steering cut it off: the calls are interrupted, and the run completed what
 * it streamed, with what it spent.
 */
export function discardAttempt(
  view: SessionView,
  input: {
    readonly runId: string;
    readonly ending: "retried" | "steered";
    readonly usage?: FactOf<"usage.recorded">["data"]["usage"];
  },
): Transition {
  const tables = view.projection.view;
  const ref = { family: "run" as const, id: input.runId };
  // A retry abandons the run, and the writer abandons what it announced with it; steering
  // completes what it streamed, so its calls close here.
  const work = input.ending === "steered" ? closeUnder(tables, ref, "steered") : [];
  if (!isOpen(tables, ref)) return unchanged(view, work);
  const run =
    input.ending === "retried"
      ? { outcome: "abandoned" as const, runId: input.runId, usage: input.usage }
      : {
          finishReason: "other",
          outcome: "completed" as const,
          runId: input.runId,
          usage: input.usage,
        };
  return unchanged(view, [...work, ...runSettledFacts(run)]);
}

/**
 * A model response made calls the runtime runs. The response waits in a suspended step until
 * every call it made has a result, so a call never reaches the model without its result.
 */
export function suspendStep(
  view: SessionView,
  step: Pick<SuspendedStep, "event" | "messages" | "tasks">,
): Transition {
  return { events: [], turn: suspend(view.turn, { ...step, requests: [] }) };
}

/** The step without the approved calls in `callIds`, which have run or joined the runtime. */
export function withoutApproved(step: SuspendedStep, callIds: ReadonlySet<string>): SuspendedStep {
  if (step.approved === undefined) return step;
  const approved = step.approved.filter((request) => !callIds.has(request.call.callId));
  if (approved.length === step.approved.length) return step;
  const { approved: _approved, ...rest } = step;
  return approved.length === 0 ? rest : { ...rest, approved };
}

/**
 * The calls of `step` a sign-in stopped that can run: every sign-in each stopped on has called
 * back.
 */
export function runnableCalls(view: SessionView, step: SuspendedStep): readonly ApprovedCall[] {
  const waiting = new Set(view.signIns.map(signInAttemptKey));
  return (step.approved ?? []).filter((call) =>
    (call.signIns ?? []).every((challenge) => !waiting.has(signInAttemptKey(challenge))),
  );
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/** Private dispatch metadata for a call that starts or reaches a task. */
export interface TaskCallStart {
  readonly clearedBy?: import("#protocol/session-events/families/call.js").ClearedBy;
  readonly callId: string;
  readonly taskId: string;
  readonly turnId: string;
  readonly kind: "agent" | "tool";
  readonly name: string;
}

/** A task starts once; every call it serves starts against that task. */
export function startTask(
  view: SessionView,
  task: TaskCallStart,
  introducedTasks?: Set<string>,
): Transition {
  const events: SessionEvent[] = [];
  const introduced =
    introducedTasks?.has(task.taskId) ?? view.projection.view.tasks[task.taskId] !== undefined;
  if (!introduced) {
    introducedTasks?.add(task.taskId);
    events.push({
      type: "task.started",
      data: {
        taskId: task.taskId,
        kind: task.kind,
        name: task.name,
        startedBy: { callId: task.callId },
      },
    });
  }
  events.push({
    type: "call.started",
    data: defined({ callId: task.callId, taskId: task.taskId, clearedBy: task.clearedBy }),
  });
  return unchanged(view, events);
}

export type TaskCallOutcome =
  | { readonly status: "completed"; readonly output?: JsonValue }
  | { readonly status: "failed"; readonly error: string }
  | { readonly status: "cancelled"; readonly reason?: TaskCancelReason };

/** A task's run settled calls: each reports its outcome, naming the task as it started. */
export function settleTask(
  view: SessionView,
  input: {
    readonly calls: readonly { readonly callId: string }[];
    readonly outcome: TaskCallOutcome;
  },
): Transition {
  const { outcome } = input;
  const output = outcome.status === "completed" ? outcome.output : undefined;
  const first = input.calls[0]?.callId;
  const settled = input.calls.map(({ callId }, index) =>
    fact("call.settled", {
      callId,
      error:
        outcome.status === "failed" ? { code: "TASK_FAILED", message: outcome.error } : undefined,
      outcome: outcome.status === "cancelled" ? "interrupted" : outcome.status,
      // The first call carries the task's output; the others name it.
      output: index === 0 ? output : undefined,
      outputOf:
        index > 0 && output !== undefined && first !== undefined ? { callId: first } : undefined,
      reason: outcome.status === "cancelled" ? (outcome.reason ?? "task-cancelled") : undefined,
    }),
  );
  return unchanged(view, settled);
}

/** A task's body ended. Replying only settles calls; it never ends a resumable task. */
export function endTask(
  view: SessionView,
  input: {
    readonly taskId: string;
    readonly outcome: TaskCallOutcome;
  },
): Transition {
  const tables = view.projection.view;
  const row = tables.tasks[input.taskId];
  if (row === undefined || row.status === "ended") return unchanged(view, []);
  const { outcome } = input;
  // The writer closes what the task still holds before this (`cascade`).
  return unchanged(view, [
    fact("task.ended", {
      error:
        outcome.status === "failed" ? { code: "TASK_FAILED", message: outcome.error } : undefined,
      outcome: outcome.status,
      reason: outcome.status === "cancelled" ? (outcome.reason ?? "task-ended") : undefined,
      taskId: input.taskId,
    }),
  ]);
}

/**
 * A task or workflow run ended, on its own or cancelled: nobody can answer what it relayed, so
 * each request still open is withdrawn.
 */
export function finishRun(
  view: SessionView,
  run: { readonly taskId?: string; readonly requestIds?: Iterable<string> },
): Transition {
  const ids = new Set(run.requestIds);
  const tables = view.projection.view;
  const withdrawn = Object.values(tables.interactions).filter(
    (row) =>
      row.status === "open" &&
      (ids.has(row.interactionId) ||
        (run.taskId !== undefined && interactionOwner(tables, row).taskId === run.taskId)),
  );
  return unchanged(
    view,
    withdrawn.map((row) => withdrawInteraction(row.interactionId, "asker-ended")),
  );
}

/** An interaction nobody needs anymore; the writer withdraws the answers still open on it. */
function withdrawInteraction(
  interactionId: string,
  reason: string,
  outcome: "withdrawn" | "interrupted" = "withdrawn",
): SessionEvent {
  return interactionSettled(interactionId, outcome, { reason });
}

// ---------------------------------------------------------------------------
// Relay
// ---------------------------------------------------------------------------

/**
 * A child session or workflow run relays one of its interaction facts. The session mirrors each
 * as its own interaction, about the call it serves, with the asker as its origin: a request
 * opens, and records where its answers go; the asker's settlement closes it; and the asker's
 * admission or refusal of an answer this session forwarded applies to the forwarded copy. The
 * open turn waits on a request about one of its calls; a task's request waits on the task.
 */
export function relay(
  view: SessionView,
  input: {
    readonly payload: SubagentInteractionHookPayload;
    /** The workflow tool run that relays the request, and the hook its `ctx.ask()` answers reach. */
    readonly runId?: string;
    readonly workflowAsk?: WorkflowAskRoute;
  },
): Transition {
  const { payload } = input;
  const tables = view.projection.view;
  const route: Relay | undefined =
    payload.route === undefined
      ? undefined
      : {
          ...payload.route,
          ...(input.workflowAsk !== undefined && { workflowAsk: input.workflowAsk }),
          ...(input.runId !== undefined && { runId: input.runId }),
        };
  const events: SessionEvent[] = [];
  const upsert: Record<string, Relay> = {};
  for (const event of payload.events) {
    const interactionId = event.data.interactionId;
    const mirror = tables.interactions[interactionId];
    if (
      event.type !== "interaction.opened" &&
      (mirror?.origin === undefined ||
        !("callId" in mirror.subject) ||
        mirror.subject.callId !== payload.callId)
    )
      continue;
    switch (event.type) {
      case "interaction.opened": {
        if (mirror !== undefined) break;
        events.push({
          data: {
            ...event.data,
            // Every relayed request names its asker; one relayed from further down names its own.
            origin: event.data.origin ?? { interactionId, sessionId: payload.childSessionId },
            subject: { callId: payload.callId },
          },
          type: "interaction.opened",
        });
        // A person answers it here, and the answer goes back the way it came.
        if (route !== undefined && event.data.request.kind !== "sign-in")
          upsert[interactionId] = route;
        break;
      }
      case "interaction.settled":
        if (mirror?.status !== "open") break;
        events.push(...mirrorSettled(tables, event.data));
        break;
      case "response.admitted": {
        // The asker admitted an answer this session forwarded: it stands here too, while the
        // rest of its batch waits.
        const answer = mirror === undefined ? undefined : forwardedAnswer(tables, event.data);
        if (answer !== undefined && tables.responses[answer]?.status === "submitted")
          events.push(responseAdmitted(answer));
        break;
      }
      case "response.settled": {
        // How the asker settled an answer this session forwarded; a deciding one settles with
        // its interaction.
        const answer = mirror === undefined ? undefined : forwardedAnswer(tables, event.data);
        if (answer !== undefined && event.data.outcome !== "applied")
          events.push(responseSettled(answer, event.data.outcome, event.data.reason));
        break;
      }
    }
  }
  // A route retires once its request closes, with the records of every closed row.
  return Object.keys(upsert).length > 0
    ? { ...unchanged(view, events), relays: upsert }
    : unchanged(view, events);
}

/** The asker settled what this session mirrors: the mirror settles the same way. */
function mirrorSettled(
  tables: PublicView,
  settled: FactOf<"interaction.settled">["data"],
): SessionEvent[] {
  const open = Object.values(tables.responses)
    .filter((row) => row.interactionId === settled.interactionId && row.status !== "settled")
    .sort((a, b) => a.introducedAt - b.introducedAt);
  const decided =
    settled.outcome === "accepted" ||
    settled.outcome === "declined" ||
    settled.outcome === "invalid";
  // The writer withdraws the answers that didn't decide (`cascade`).
  const decider = decided ? open.at(-1) : undefined;
  const events: SessionEvent[] =
    decider === undefined ? [] : [responseSettled(decider.responseId, "applied", settled.reason)];
  const cause = decider === undefined ? settled.cause : { responseId: decider.responseId };
  events.push(fact("interaction.settled", { ...settled, cause }));
  return events;
}

/** The answer this session forwarded that an asker's settlement is about. */
function forwardedAnswer(
  tables: PublicView,
  settled: { readonly interactionId: string; readonly deliveryId?: string },
): string | undefined {
  const open = Object.values(tables.responses)
    .filter((row) => row.interactionId === settled.interactionId && row.status !== "settled")
    .sort((a, b) => a.introducedAt - b.introducedAt);
  return (
    open.find((row) => settled.deliveryId !== undefined && row.deliveryId === settled.deliveryId) ??
    open.at(-1)
  )?.responseId;
}

/**
 * Answers to requests this session relays went on to their askers. Each delivery that carried
 * such answers is admitted here, with the answers it forwarded. An answer joins the open turn
 * that asked; a delivery that also carries input for this session goes on to its turn. Between
 * turns, forwarding alone applies the delivery. A question this session decides settles now; an
 * approval stays open until its asker settles it.
 */
export function routeAnswer(
  view: SessionView,
  input: {
    readonly deliveries: readonly {
      readonly deliveryId: string;
      readonly principal?: Principal;
      readonly source?: DeliverySource;
      /** The open asking turn consumes the answer, with any message parts it carried. */
      readonly consumed?: { readonly turnId: string; readonly parts: readonly UserPart[] };
      /** The delivery also carries input for this session, whose turn consumes and settles it. */
      readonly continues?: true;
    }[];
    /** Every answer forwarded, as admitted. */
    readonly forwarded: readonly ResponseSubmittedData[];
    /**
     * Relayed requests this session settles as it forwards their answer, because nobody else
     * will before it acts: a workflow run's `ctx.ask()` question, since a run publishes nothing of
     * its own, and a child's budget prompt this session stops on, since Stop ends its own turn.
     */
    readonly decided: readonly {
      readonly answer: Answer;
      readonly outcome: "accepted" | "declined";
    }[];
  },
): Transition {
  const tables = view.projection.view;
  const events: SessionEvent[] = [];
  const admitted = new Set<string>();
  for (const delivery of input.deliveries) {
    if (tables.deliveries[delivery.deliveryId] !== undefined || admitted.has(delivery.deliveryId))
      continue;
    admitted.add(delivery.deliveryId);
    const { deliveryId, principal, source } = delivery;
    events.push(fact("delivery.admitted", { deliveryId, principal, source }));
    if (delivery.consumed !== undefined) {
      events.push(
        consumed({ deliveryId, parts: delivery.consumed.parts }, delivery.consumed.turnId),
      );
    }
  }
  const known = (deliveryId: string) =>
    admitted.has(deliveryId) || tables.deliveries[deliveryId] !== undefined;
  const submitted = new Map<string, ResponseSubmittedData>();
  for (const binding of input.forwarded) {
    if (tables.responses[binding.responseId] !== undefined) continue;
    if (tables.interactions[binding.interactionId]?.status !== "open") continue;
    if (!known(binding.deliveryId)) continue;
    submitted.set(binding.responseId, binding);
    events.push(responseSubmitted(binding));
  }
  for (const { answer, outcome } of input.decided) {
    const row = tables.interactions[answer.interactionId];
    if (row?.status !== "open") continue;
    const answers = [
      ...Object.values(tables.responses)
        .filter((entry) => entry.interactionId === row.interactionId && entry.status !== "settled")
        .map((entry) => entry.responseId),
      ...[...submitted.values()]
        .filter((binding) => binding.interactionId === row.interactionId)
        .map((binding) => binding.responseId),
    ];
    // The latest answer decides; the writer withdraws the others (`cascade`).
    const decider = answers.at(-1);
    if (decider !== undefined) events.push(responseSettled(decider, "applied"));
    events.push(
      interactionSettled(row.interactionId, outcome, {
        cause: decider === undefined ? undefined : { responseId: decider },
        response: answer,
      }),
    );
  }
  for (const delivery of input.deliveries) {
    if (
      delivery.consumed !== undefined ||
      delivery.continues === true ||
      !admitted.has(delivery.deliveryId)
    )
      continue;
    events.push(deliveryApplied(delivery.deliveryId));
  }
  // The answered routes retire with the commit, so a later delivery can't route through them.
  return unchanged(view, events);
}

// ---------------------------------------------------------------------------
// Sign-ins
// ---------------------------------------------------------------------------

/**
 * Sign-in callbacks matched the attempts `attemptIds` name: the session stops waiting on them.
 * A call they stopped runs once every sign-in it waits on has called back (`runnableCalls`); any
 * other completion reports once the turn it resumes runs (`completeSignIn`).
 */
export function matchSignIns(
  view: SessionView,
  input: { readonly attemptIds: readonly string[] },
): Transition {
  const matched = new Set(input.attemptIds);
  return {
    ...unchanged(view, []),
    signIns: view.signIns.filter((challenge) => !matched.has(signInAttemptKey(challenge))),
  };
}

/** The sign-ins calls stopped on, which the calls report when they settle. */
export function callSignIns(turn: TurnState): readonly AuthorizationChallenge[] {
  return turn.suspended.flatMap((step) =>
    (step.approved ?? []).flatMap((call) => call.signIns ?? []),
  );
}

/**
 * The `stopped` calls wait for a sign-in: their results leave the step, and they stay approved and
 * open, to run once the sign-ins call back, rather than the model asking for them again.
 */
export function awaitSignIns(
  step: SuspendedStep,
  input: {
    readonly stopped: readonly StoppedCall[];
    readonly challenges: readonly AuthorizationChallenge[];
  },
): SuspendedStep {
  const ids = stepCallIds(step);
  const stopped = input.stopped.filter(({ call }) => ids.has(call.callId));
  if (stopped.length === 0) return step;
  const calls = stopped.map(({ approval, call, connections }): ApprovedCall => {
    // A call approved before keeps its approval, and the sign-ins it already waited on report
    // with it, beside the ones it waits on now.
    const earlier = step.approved?.find((approved) => approved.call.callId === call.callId);
    const interactionId = approval?.interactionId ?? earlier?.interactionId;
    const responder = approval?.responder ?? earlier?.responder;
    return {
      call,
      ...(interactionId !== undefined && { interactionId }),
      ...(responder !== undefined && { responder }),
      signIns: [
        ...(earlier?.signIns ?? []),
        ...input.challenges.filter((challenge) => connections.includes(challenge.name)),
      ],
    };
  });
  const callIds = new Set(calls.map((call) => call.call.callId));
  return {
    ...step,
    messages: withoutResults(step.messages, callIds),
    approved: [...(step.approved ?? []).filter((call) => !callIds.has(call.call.callId)), ...calls],
  };
}

/**
 * The facts that settle a sign-in its callback completed, while the session still waits on it. A
 * callback is a delivery whose response carries no value: the provider's payload stays private,
 * and the public record says only that the attempt completed and how it came out.
 */
function signInCallbackFacts(
  tables: PublicView,
  challenge: AuthorizationChallenge,
  settled: {
    readonly outcome: "accepted" | "failed";
    readonly reason?: string;
    readonly retryable?: boolean;
  },
): SessionEvent[] {
  const interactionId = signInInteractionId(challenge);
  const row = tables.interactions[interactionId];
  if (row?.status !== "open") return [];
  // One callback per attempt reaches the session, so the attempt names its delivery.
  const deliveryId = `callback_${interactionId}`;
  const responseId = `response_${deliveryId}`;
  const ended = interactionSettled(interactionId, settled.outcome, {
    cause: { responseId },
    ...(settled.reason !== undefined && { reason: settled.reason }),
  });
  return [
    { data: { deliveryId, source: { callback: "authorization" } }, type: "delivery.admitted" },
    responseSubmitted({ deliveryId, interactionId, responseId }),
    responseSettled(responseId, "applied"),
    // A terminal failure says so: the turn reports it rather than asking for the sign-in again.
    settled.retryable === false
      ? { ...ended, data: { ...ended.data, response: { retryable: false } } }
      : ended,
    deliveryApplied(deliveryId),
  ];
}

/**
 * A call a sign-in stopped settled: the sign-ins it waited on end with it, accepted if it returned
 * and failed with the reason it didn't. A failure with `retryable: false` is terminal, recorded as
 * the settlement's `response.retryable`. Published before the call's own settlement.
 */
export function callSignInsSettled(
  view: Pick<SessionView, "projection">,
  call: ApprovedCall,
  failure?: { readonly reason?: string; readonly retryable?: boolean },
): SessionEvent[] {
  const tables = view.projection.view;
  const settled =
    failure === undefined
      ? { outcome: "accepted" as const }
      : { ...failure, outcome: "failed" as const };
  return (call.signIns ?? []).flatMap((challenge) =>
    signInCallbackFacts(tables, challenge, settled),
  );
}

/**
 * Sign-in callbacks arrived: each attempt the session still waits on is accepted. A sign-in a
 * call stopped on settles with the call instead (`callSignInsSettled`).
 */
export function completeSignIn(
  view: SessionView,
  input: { readonly completions: readonly AuthorizationChallenge[] },
): Transition {
  const tables = view.projection.view;
  // A call a sign-in stopped reports it when the call settles.
  const reportedByCalls = new Set(callSignIns(view.turn).map(signInAttemptKey));
  return unchanged(
    view,
    input.completions
      .filter((challenge) => !reportedByCalls.has(signInAttemptKey(challenge)))
      .flatMap((challenge) => signInCallbackFacts(tables, challenge, { outcome: "accepted" })),
  );
}

// ---------------------------------------------------------------------------
// Cancel and clear
// ---------------------------------------------------------------------------

/**
 * The delivery a clear or compact arrived as. One that names none, from a caller that predates
 * control ids, is named by the position it applies at.
 */
export function controlDeliveryFor(view: SessionView, given?: ControlDelivery): ControlDelivery {
  return given ?? { deliveryId: `control_${String(view.projection.view.position)}` };
}

/**
 * A control's transition as a delivery: admitted before what it changes and applied after, in
 * the same commit, with what it changes naming it as the cause. A control that names no
 * delivery changes the session on its own.
 */
export function controlled(
  delivery: ControlDelivery | undefined,
  control: string,
  build: (cause: Cause | undefined) => Transition,
): Transition {
  if (delivery === undefined) return build(undefined);
  const transition = build({ deliveryId: delivery.deliveryId });
  return {
    ...transition,
    events: [
      controlAdmitted(delivery, control),
      ...transition.events,
      deliveryApplied(delivery.deliveryId),
    ],
  };
}

/** What the model reads for a call its turn's cancellation stopped before the call settled. */
export const CANCELLED_CALL_RESULT = "The turn was cancelled before this call finished.";

/**
 * `session.cancel()`: the open turn ends cancelled. Its requests, its sign-ins, and every
 * relayed request are withdrawn, since the cancel stops the work that asked them; its unsettled
 * calls are stopped. The steps it ran commit to history, each unfinished call answered as
 * cancelled, so the model sees that the work started and stopped.
 */
export function cancel(view: SessionView, input: { readonly cause?: Cause } = {}): Transition {
  const { projection } = view;
  const turnId = activeTurnIdOf(projection);
  const stopped = view.turn.suspended.filter(
    (step) =>
      (turnId !== undefined && step.event.turnId === turnId) ||
      step.tasks.some((task) => !answeredCallIds(step.messages).has(task.callId)) ||
      (step.approved?.length ?? 0) > 0,
  );
  const stoppedRequestIds = new Set(
    stopped.flatMap((step) => step.requests.map((request) => request.interactionId)),
  );
  const tables = projection.view;
  // The cancel also stops the work behind every relayed request and the stopped steps' asks,
  // wherever they sit; the writer closes the rest of what the turn held.
  const events: SessionEvent[] = Object.values(tables.interactions)
    .filter(
      (row) =>
        row.status === "open" &&
        (view.relayedRequestIds.has(row.interactionId) ||
          stoppedRequestIds.has(row.interactionId) ||
          row.request.kind === "budget"),
    )
    .map((row) => withdrawInteraction(row.interactionId, "Cancelled.", "interrupted"));
  events.push(
    ...turnSettled(
      projection,
      { cause: input.cause, outcome: "cancelled" },
      activeTurn(tables)?.turnId ?? turnId,
    ),
    ...unreadSettled(view),
  );
  const { queued: _queued, ...turn } = view.turn;
  return {
    ...commitSteps(turn, stopped, cancelledTranscript),
    events,
    signIns: [],
  };
}

function unreadSettled(view: SessionView): SessionEvent[] {
  const tables = view.projection.view;
  return (view.turn.queued?.deliveries ?? [])
    .filter(({ deliveryId }) => tables.deliveries[deliveryId]?.status === "admitted")
    .map(({ deliveryId }) => fact("delivery.settled", { deliveryId, outcome: "ignored" }));
}

/** A stopped step's response, each call without a result answered as cancelled. */
function cancelledTranscript(step: SuspendedStep): ModelMessage[] {
  return stoppedTranscript(step, () => CANCELLED_CALL_RESULT);
}

/**
 * A step was interrupted after it published, and its retry runs from the checkpoint before it.
 * Each step waiting on what the interrupted attempt did, an answer it applied or a call it
 * started, can't resume from it again: the step stops, each call it made answered with what the
 * stream says of it, so none runs again. The events the attempt wrote already say what changed.
 */
export function stopInterruptedSteps(
  view: SessionView,
  input: {
    readonly calls: ReadonlyMap<string, InterruptedCall>;
    readonly settledInteractions: ReadonlySet<string>;
  },
): Transition {
  const stopped = view.turn.suspended.filter(
    (step) =>
      step.requests.some((request) => input.settledInteractions.has(request.interactionId)) ||
      [...stepCallIds(step)].some((callId) => input.calls.get(callId)?.started === true),
  );
  return {
    ...commitSteps(view.turn, stopped, (step) =>
      stoppedTranscript(step, (callId) => interruptedCallResult(input.calls.get(callId))),
    ),
    events: [],
  };
}

function commitSteps(
  turn: TurnState,
  completed: readonly SuspendedStep[],
  messages: (step: SuspendedStep) => readonly ModelMessage[] = (step) => step.messages,
): { readonly commit: readonly ModelMessage[]; readonly turn: TurnState } {
  const removed = new Set(completed);
  return {
    commit: completed.flatMap(messages),
    turn: { ...turn, suspended: turn.suspended.filter((step) => !removed.has(step)) },
  };
}

/** A stopped step's response, each call without a result answered with `resultOf` it. */
function stoppedTranscript(
  step: SuspendedStep,
  resultOf: (callId: string) => string,
): ModelMessage[] {
  const answered = answeredCallIds(step.messages);
  let messages = [...step.messages];
  for (const message of step.messages) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type !== "tool-call" || part.providerExecuted === true) continue;
      if (answered.has(part.toolCallId)) continue;
      messages = withResult(messages, {
        output: { type: "text", value: resultOf(part.toolCallId) },
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        type: "tool-result",
      });
    }
  }
  return messages;
}

/**
 * `session.clear()`: everything the cleared history asked for is withdrawn, its approvals and
 * the session-limit prompt and every sign-in, and the calls awaiting them stop. Requests relayed
 * from live tasks stay: clearing doesn't stop the work that asked them.
 */
export function clear(view: SessionView, input: { readonly cause?: Cause } = {}): Transition {
  const { projection } = view;
  const changeId = nextChangeId(projection);
  return {
    clearsHistory: true,
    signIns: [],
    events: [
      ...clearedInteractions(view),
      // Clear runs between turns. A paused turn still owns a lifecycle; end it and its
      // non-task work before selecting an empty conversation, instead of dropping only its
      // private suspended steps and leaving the public turn and calls open forever.
      ...turnSettled(projection, { cause: input.cause, outcome: "cancelled" }),
      ...unreadSettled(view),
      contextStarted({ cause: input.cause, changeId, kind: "clear" }),
      fact("context.settled", { changeId, kind: "clear", outcome: "completed", selects: null }),
    ],
    turn: { remembered: view.turn.remembered, suspended: [] } satisfies TurnState,
  };
}

/**
 * What a clear withdraws: every request the cleared history asked for, its turn's too. Requests
 * relayed from live tasks stay.
 */
function clearedInteractions(view: SessionView): SessionEvent[] {
  const tables = view.projection.view;
  return Object.values(tables.interactions)
    .filter((row) => row.status === "open" && !view.relayedRequestIds.has(row.interactionId))
    .map((row) =>
      withdrawInteraction(row.interactionId, "The context was cleared.", "interrupted"),
    );
}
