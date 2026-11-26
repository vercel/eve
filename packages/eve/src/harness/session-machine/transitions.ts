import type { ModelMessage } from "ai";

import type { SubagentInteractionHookPayload } from "#channel/types.js";
import type { AuthorizationChallenge } from "#harness/authorization.js";
import { callSettledFrom, callStarted } from "#harness/call-facts.js";
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
import type { Cause, Principal, Usage, UserPart } from "#protocol/session-events/envelope.js";
import type { TokenUsage } from "#shared/token-usage.js";
import type { FactOf } from "#protocol/session-events/facts.js";
import {
  activeTurnIdOf,
  nextChangeId,
  openRunOf,
  type SessionProjection,
} from "#protocol/session-projection.js";
import type {
  InteractionRow,
  SessionView as PublicView,
} from "#protocol/session-projection/tables.js";
import type { RuntimeActionResult } from "#shared/action-types.js";
import type { Answer } from "#shared/input.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import { transition, type Transition } from "./commit.js";
import type { HistoryChange } from "./history.js";
import {
  SIGN_IN_DECLINED,
  signInAttemptKey,
  waitingSignIn,
  type CallsBack,
} from "#harness/hitl/sign-ins.js";
import { forwardedFrom, type Relay, type WorkflowAskRoute } from "#harness/hitl/relays.js";
import type { StoppedCall } from "#harness/inline-tool-authorization.js";
import type { ApprovedCall, ProgramCallResult, SuspendedStep, TurnState } from "./state.js";
import { isProgramCall, programsOf, resumePrograms, withoutPrograms } from "./programs.js";
import { activeTurnId, answeredCallIds, turnPosition, type SessionView } from "./view.js";
import {
  isComplete,
  stepCallIds,
  suspend,
  withResult,
  withoutResults,
  type ToolResultPart,
} from "./suspended-steps.js";

const unchanged = (view: SessionView, events: readonly SessionEvent[]) =>
  transition({ events, turn: view.turn });

export interface ConsumedDelivery {
  readonly deliveryId: string;
  readonly parts: readonly UserPart[];
  readonly history?: readonly ImportedMessage[];
}

function followedTurn(projection: SessionProjection): string | null {
  const selection = projection.view.selection;
  if (selection === null) return null;
  return selection?.turnId ?? projection.view.session.latestTurnId ?? null;
}

function waitingDeliveries(
  projection: SessionProjection,
  deliveries: readonly ConsumedDelivery[],
): readonly ConsumedDelivery[] {
  return deliveries.filter(
    ({ deliveryId }) => projection.view?.deliveries[deliveryId]?.status === "admitted",
  );
}

function consumed(delivery: ConsumedDelivery, turnId: string): SessionEvent {
  return fact("delivery.consumed", {
    deliveryId: delivery.deliveryId,
    history: (delivery.history?.length ?? 0) > 0 ? delivery.history : undefined,
    parts: delivery.parts,
    turnId,
  });
}

export function receive(
  view: SessionView,
  input: {
    readonly deliveries?: readonly ConsumedDelivery[];
    readonly cause?: Cause;
    readonly parent?: { readonly sessionId: string; readonly callId: string };
    readonly predecessor?: SessionPredecessor;
    readonly runtime?: RuntimeIdentity;
    readonly trace?: TraceContext;
  },
): Transition {
  const { projection } = view;
  const position = turnPosition(projection);
  const turnId = activeTurnId(position);
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

export function complete(view: SessionView): Transition {
  return unchanged(view, turnSettled(view.projection, { outcome: "completed" }));
}

export function clearedByAttempt(view: SessionView): Transition {
  return transition({
    events: [],
    history: { rewrite: [] },
    signIns: [],
    turn: { remembered: view.turn.remembered, suspended: [] },
  });
}

export function fail(
  view: SessionView,
  failure: {
    readonly code: string;
    readonly details?: JsonObject;
    readonly message: string;
    readonly terminal?: true;
    readonly usage?: Usage;
  },
): Transition {
  const programs = new Set(programsOf(view.turn).map(({ callId }) => callId));
  const stopped = view.turn.suspended.filter(
    (step) =>
      (step.approved?.length ?? 0) > 0 ||
      step.program !== undefined ||
      [...stepCallIds(step)].some((callId) => programs.has(callId)),
  );
  const error = errorInfoOf(failure);
  const turnId = activeTurnIdOf(view.projection);
  const runId = turnId === undefined ? undefined : openRunOf(view.projection, turnId);
  const events = [
    ...(runId === undefined
      ? []
      : runSettledFacts({ runId, outcome: "failed", error, usage: failure.usage })),
    ...(failure.terminal === undefined
      ? turnSettled(view.projection, { error, outcome: "failed" })
      : sessionEndedFacts(view.projection, {
          cause: turnId === undefined ? undefined : { turnId },
          error,
          outcome: "failed",
        })),
  ];
  return transition({ ...commitSteps(view.turn, stopped, () => CANCELLED_CALL_RESULT), events });
}

export interface SettledCall {
  readonly part: ToolResultPart;
  readonly result?: RuntimeActionResult;
  readonly usage?: TokenUsage;
}

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
    if (
      result !== undefined &&
      recorded !== undefined &&
      recorded.taskId === undefined &&
      recorded.status !== "settled"
    ) {
      events.push(callSettledFrom(result));
      if (usage !== undefined) events.push(delegatedUsageFact(result.callId, usage));
    }
  }
  const complete = steps.filter(isComplete);
  return transition({ ...commitSteps({ ...view.turn, suspended: steps }, complete), events });
}

export function discardAttempt(
  view: SessionView,
  input: {
    readonly runId: string;
    readonly ending: "retried" | "steered";
    readonly usage?: Usage;
  },
): Transition {
  const tables = view.projection.view;
  const ref = { family: "run" as const, id: input.runId };
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

export function suspendStep(
  view: SessionView,
  step: Pick<SuspendedStep, "endsTurn" | "event" | "messages" | "program" | "tasks">,
): Transition {
  return transition({ events: [], turn: suspend(view.turn, { ...step, requests: [] }) });
}

export function withoutApproved(step: SuspendedStep, callIds: ReadonlySet<string>): SuspendedStep {
  if (step.approved === undefined) return step;
  const approved = step.approved.filter((request) => !callIds.has(request.call.callId));
  if (approved.length === step.approved.length) return step;
  const { approved: _approved, ...rest } = step;
  return approved.length === 0 ? rest : { ...rest, approved };
}

export function runnableCalls(view: SessionView, step: SuspendedStep): readonly ApprovedCall[] {
  const waiting = new Set(view.signIns.map(signInAttemptKey));
  return (step.approved ?? []).filter((call) =>
    (call.signIns ?? []).every((challenge) => !waiting.has(signInAttemptKey(challenge))),
  );
}

export interface TaskCallStart {
  readonly clearedBy?: import("#protocol/session-events/families/call.js").ClearedBy;
  readonly callId: string;
  readonly taskId: string;
  readonly turnId: string;
  readonly kind: "agent" | "tool";
  readonly name: string;
}

export interface PendingDispatch {
  readonly executing: readonly {
    readonly callId: string;
    readonly clearedBy?: import("#protocol/session-events/families/call.js").ClearedBy;
  }[];
  readonly started: readonly TaskCallStart[];
  readonly refused: readonly { readonly result: RuntimeActionResult; readonly policy: string }[];
}

export function startDispatchedCalls(view: SessionView, pending: PendingDispatch): Transition {
  const introducedTasks = new Set(Object.keys(view.projection.view.tasks));
  return unchanged(view, [
    ...pending.executing.map(({ callId, clearedBy }) => callStarted(callId, { clearedBy })),
    ...pending.started.flatMap((task) => startTask(view, task, introducedTasks).events),
    ...pending.refused.map(({ policy, result }) =>
      callSettledFrom(result, {
        cause: { policy },
        rejected: view.projection.view.calls[result.callId]?.status !== "running",
      }),
    ),
  ]);
}

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
  if (view.projection.view.calls[task.callId]?.status !== "running") {
    events.push({
      type: "call.started",
      data: defined({ callId: task.callId, taskId: task.taskId, clearedBy: task.clearedBy }),
    });
  }
  return unchanged(view, events);
}

export type TaskCallOutcome =
  | { readonly status: "completed"; readonly output?: JsonValue }
  | { readonly status: "failed"; readonly error: string }
  | { readonly status: "cancelled"; readonly reason?: TaskCancelReason };

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
      output: index === 0 ? output : undefined,
      outputOf:
        index > 0 && output !== undefined && first !== undefined ? { callId: first } : undefined,
      reason: outcome.status === "cancelled" ? (outcome.reason ?? "task-cancelled") : undefined,
    }),
  );
  return unchanged(view, settled);
}

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

function withdrawInteraction(
  interactionId: string,
  reason: string,
  outcome: "withdrawn" | "interrupted" = "withdrawn",
): SessionEvent {
  return interactionSettled(interactionId, outcome, { reason });
}

export function relay(
  view: SessionView,
  input: {
    readonly callsBack?: CallsBack;
    readonly payload: SubagentInteractionHookPayload;
    readonly relays?: ReadonlyMap<string, Relay>;
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
  const served = tables.calls[payload.callId];
  const running = (taskId: string | undefined) =>
    taskId !== undefined && tables.tasks[taskId]?.status === "running";
  const serving =
    (served !== undefined && (served.status !== "settled" || running(served.taskId))) ||
    Object.values(tables.tasks).some(
      (task) => task.status === "running" && task.startedBy.callId === payload.callId,
    );
  for (const event of payload.events) {
    const interactionId = event.data.interactionId;
    const mirror = tables.interactions[interactionId];
    const answersRoute = input.relays?.get(interactionId) ?? route;
    if (event.type === "interaction.opened" && !serving) continue;
    if (
      event.type !== "interaction.opened" &&
      relayedMirror(tables, payload, interactionId) === undefined
    )
      continue;
    switch (event.type) {
      case "interaction.opened": {
        if (mirror !== undefined) break;
        events.push({
          data: waitingSignIn(
            tables,
            {
              ...event.data,
              origin: event.data.origin ?? { interactionId, sessionId: payload.childSessionId },
              subject: { callId: payload.callId },
            },
            input.callsBack,
          ),
          type: "interaction.opened",
        });
        if (route !== undefined && event.data.request.kind !== "sign-in")
          upsert[interactionId] = route;
        break;
      }
      case "interaction.settled":
        if (mirror?.status !== "open") break;
        events.push(...mirrorSettled(tables, event.data, answersRoute));
        break;
      case "response.admitted": {
        const answer =
          mirror === undefined
            ? undefined
            : forwardedAnswer(tables, interactionId, event.data.deliveryId, answersRoute);
        if (answer !== undefined && tables.responses[answer]?.status === "submitted")
          events.push(responseAdmitted(answer));
        break;
      }
      case "response.settled": {
        const answer =
          mirror === undefined
            ? undefined
            : forwardedAnswer(tables, interactionId, event.data.deliveryId, answersRoute);
        if (answer !== undefined && event.data.outcome !== "applied")
          events.push(responseSettled(answer, event.data.outcome, event.data.reason));
        break;
      }
    }
  }
  return Object.keys(upsert).length > 0
    ? { ...unchanged(view, events), relays: upsert }
    : unchanged(view, events);
}

export function relayedMirror(
  tables: PublicView,
  payload: SubagentInteractionHookPayload,
  interactionId: string,
): InteractionRow | undefined {
  const mirror = tables.interactions[interactionId];
  return mirror?.origin !== undefined &&
    "callId" in mirror.subject &&
    mirror.subject.callId === payload.callId
    ? mirror
    : undefined;
}

function mirrorSettled(
  tables: PublicView,
  settled: FactOf<"interaction.settled">["data"],
  route: Relay | undefined,
): SessionEvent[] {
  const decided =
    settled.outcome === "accepted" ||
    settled.outcome === "declined" ||
    settled.outcome === "invalid";
  const named =
    settled.cause !== undefined && "deliveryId" in settled.cause
      ? settled.cause.deliveryId
      : undefined;
  const decider = decided
    ? forwardedAnswer(tables, settled.interactionId, named, route)
    : undefined;
  const events: SessionEvent[] =
    decider === undefined ? [] : [responseSettled(decider, "applied", settled.reason)];
  const cause =
    decider !== undefined
      ? { responseId: decider }
      : settled.cause !== undefined && ("policy" in settled.cause || "hook" in settled.cause)
        ? settled.cause
        : undefined;
  events.push(fact("interaction.settled", { ...settled, cause }));
  return events;
}

function forwardedAnswer(
  tables: PublicView,
  interactionId: string,
  deliveryId: string | undefined,
  route: Relay | undefined,
): string | undefined {
  const open = Object.values(tables.responses).filter(
    (row) => row.interactionId === interactionId && row.status !== "settled",
  );
  if (deliveryId === undefined) return open.length === 1 ? open[0]!.responseId : undefined;
  if (route?.remote !== undefined) {
    const receipts = route.receipts ?? {};
    const ours = Object.hasOwn(receipts, deliveryId) ? receipts[deliveryId] : undefined;
    return open.find((row) => row.deliveryId === ours)?.responseId;
  }
  const source = forwardedFrom(deliveryId);
  return (
    open.find((row) => row.deliveryId === deliveryId) ??
    open.find((row) => row.deliveryId === source)
  )?.responseId;
}

export function routeAnswer(
  view: SessionView,
  input: {
    readonly deliveries: readonly {
      readonly deliveryId: string;
      readonly principal?: Principal;
      readonly source?: DeliverySource;
      readonly consumed?: { readonly turnId: string; readonly parts: readonly UserPart[] };
      readonly continues?: true;
    }[];
    readonly forwarded: readonly ResponseSubmittedData[];
    readonly decided: readonly {
      readonly answer: Answer;
      readonly outcome: "accepted" | "declined";
    }[];
    readonly relays?: Readonly<Record<string, Relay>>;
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
  return input.relays === undefined
    ? unchanged(view, events)
    : { ...unchanged(view, events), relays: input.relays };
}

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

export function callSignIns(turn: TurnState): readonly AuthorizationChallenge[] {
  return turn.suspended.flatMap((step) =>
    (step.approved ?? []).flatMap((call) => call.signIns ?? []),
  );
}

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

function signInCallbackFacts(
  tables: PublicView,
  challenge: AuthorizationChallenge,
  settled: {
    readonly outcome: "accepted" | "declined" | "failed";
    readonly reason?: string;
    readonly retryable?: boolean;
  },
): SessionEvent[] {
  const interactionId = signInInteractionId(challenge);
  const row = tables.interactions[interactionId];
  if (row?.status !== "open") return [];
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
    settled.retryable === false
      ? { ...ended, data: { ...ended.data, response: { retryable: false } } }
      : ended,
    deliveryApplied(deliveryId),
  ];
}

export function callSignInsSettled(
  view: Pick<SessionView, "projection">,
  call: ApprovedCall,
  failure?: { readonly reason?: string; readonly retryable?: boolean },
): SessionEvent[] {
  const tables = view.projection.view;
  const settled =
    failure === undefined
      ? { outcome: "accepted" as const }
      : {
          ...failure,
          outcome:
            failure.reason === SIGN_IN_DECLINED ? ("declined" as const) : ("failed" as const),
        };
  return (call.signIns ?? []).flatMap((challenge) =>
    signInCallbackFacts(tables, challenge, settled),
  );
}

export function completeSignIn(
  view: SessionView,
  input: {
    readonly completions: readonly AuthorizationChallenge[];
    readonly declined: ReadonlySet<string>;
  },
): Transition {
  const tables = view.projection.view;
  const reportedByCalls = new Set(callSignIns(view.turn).map(signInAttemptKey));
  return unchanged(
    view,
    input.completions
      .filter((challenge) => !reportedByCalls.has(signInAttemptKey(challenge)))
      .flatMap((challenge) =>
        signInCallbackFacts(
          tables,
          challenge,
          challenge.attemptId !== undefined && input.declined.has(challenge.attemptId)
            ? { outcome: "declined", reason: SIGN_IN_DECLINED, retryable: false }
            : { outcome: "accepted" },
        ),
      ),
  );
}

export function controlDeliveryFor(view: SessionView, given?: ControlDelivery): ControlDelivery {
  return given ?? { deliveryId: `control_${String(view.projection.view.position)}` };
}

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

export const CANCELLED_CALL_RESULT = "The turn was cancelled before this call finished.";

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
  return transition({
    ...commitSteps(turn, stopped, () => CANCELLED_CALL_RESULT),
    events,
    signIns: [],
  });
}

function unreadSettled(view: SessionView): SessionEvent[] {
  const tables = view.projection.view;
  return (view.turn.queued?.deliveries ?? [])
    .filter(({ deliveryId }) => tables.deliveries[deliveryId]?.status === "admitted")
    .map(({ deliveryId }) => fact("delivery.settled", { deliveryId, outcome: "ignored" }));
}

export function stopInterruptedSteps(
  view: SessionView,
  input: {
    readonly calls: ReadonlyMap<string, InterruptedCall>;
    readonly settledInteractions: ReadonlySet<string>;
  },
): Transition {
  const programs = programsOf(view.turn);
  const runs = (callId: string) => programs.some((program) => program.callId === callId);
  const stopped = view.turn.suspended.filter(
    (step) =>
      step.requests.some((request) => input.settledInteractions.has(request.interactionId)) ||
      [...stepCallIds(step)].some(
        (callId) => !runs(callId) && input.calls.get(callId)?.started === true,
      ),
  );
  const { history, turn } = commitSteps(
    view.turn,
    stopped,
    (callId) => interruptedCallResult(input.calls.get(callId)),
    (callId) => interruptedProgramCall(input.calls.get(callId)),
  );
  const recovered = programsOf(turn).map((program) => {
    const calls = [...input.calls].filter(([callId]) => isProgramCall(program.callId, callId));
    if (calls.length === 0) return program;
    return {
      ...program,
      recovered: {
        ...program.recovered,
        ...Object.fromEntries(
          calls.map(([callId, { error, name, outcome, output, started }]) => [
            callId,
            defined({ error, name, outcome, output, started }),
          ]),
        ),
      },
    };
  });
  return transition({
    events: [],
    history,
    turn: recovered.length === 0 ? turn : { ...turn, programs: recovered },
  });
}

export function interruptedProgramCall(call: InterruptedCall | undefined): ProgramCallResult {
  switch (call?.outcome) {
    case "completed":
      return call.output === undefined
        ? {
            error: interruptedCallResult(call),
            outcome: "abandoned",
            status: "failed",
          }
        : { output: call.output, status: "completed" };
    case "failed":
      return { error: call.error ?? interruptedCallResult(call), status: "failed" };
    case "rejected":
      return {
        error: call.error ?? interruptedCallResult(call),
        outcome: "rejected",
        status: "failed",
      };
    default:
      return { error: interruptedCallResult(call), outcome: "abandoned", status: "failed" };
  }
}

function commitSteps(
  turn: TurnState,
  completed: readonly SuspendedStep[],
  stoppedResultOf?: (callId: string) => string,
  stoppedProgramCall: (callId: string) => ProgramCallResult = (callId) => ({
    error: stoppedResultOf?.(callId) ?? "This call did not run.",
    outcome: "interrupted",
    status: "failed",
  }),
): { readonly history: HistoryChange; readonly turn: TurnState } {
  const removed = new Set(completed);
  const responses = completed.filter((step) => step.program === undefined);
  const batches = completed.filter((step) => step.program !== undefined);
  const remaining = { ...turn, suspended: turn.suspended.filter((step) => !removed.has(step)) };
  return {
    history: {
      append: responses.flatMap((step) =>
        stoppedResultOf === undefined ? step.messages : stoppedTranscript(step, stoppedResultOf),
      ),
    },
    turn: withoutPrograms(
      resumePrograms(remaining, batches, stoppedProgramCall),
      new Set(responses.flatMap((step) => [...stepCallIds(step)])),
    ),
  };
}

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

export function clear(view: SessionView, input: { readonly cause?: Cause } = {}): Transition {
  const { projection } = view;
  const changeId = nextChangeId(projection);
  return transition({
    history: { rewrite: [] },
    signIns: [],
    events: [
      ...clearedInteractions(view),
      ...turnSettled(projection, { cause: input.cause, outcome: "cancelled" }),
      ...unreadSettled(view),
      contextStarted({ cause: input.cause, changeId, kind: "clear" }),
      fact("context.settled", { changeId, kind: "clear", outcome: "completed", selects: null }),
    ],
    turn: { remembered: view.turn.remembered, suspended: [] } satisfies TurnState,
  });
}

function clearedInteractions(view: SessionView): SessionEvent[] {
  const tables = view.projection.view;
  return Object.values(tables.interactions)
    .filter((row) => row.status === "open" && !view.relayedRequestIds.has(row.interactionId))
    .map((row) =>
      withdrawInteraction(row.interactionId, "The context was cleared.", "interrupted"),
    );
}
