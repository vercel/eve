import type { ModelMessage, ToolCallPart } from "ai";

import type {
  SubagentAuthorizationEventHookPayload,
  SubagentInputRequestHookPayload,
} from "#channel/types.js";
import type { AuthorizationChallenge } from "#harness/authorization.js";
import { authorizationEventFields } from "#harness/authorization-event-fields.js";
import { callSettledFrom } from "#harness/call-facts.js";
import {
  createAuthorizationCompletedEvent,
  createAuthorizationRequiredEvent,
  createInputRequestedEvent,
  createInputResolvedEvent,
  createTaskSettledEvent,
  createTaskStartedEvent,
  type InputResolution,
  type RuntimeIdentity,
  type RuntimeTraceContext,
  type TaskCancelReason,
  type TaskStartedStreamEvent,
} from "#protocol/message.js";
import type { SessionEvent } from "#protocol/session-event.js";
import type { Cause, ErrorInfo, UserPart } from "#protocol/session-events/envelope.js";
import type { FactOf } from "#protocol/session-events/facts.js";
import type { TurnAwaiting } from "#protocol/session-events/families/turn.js";
import {
  nextChangeId,
  nextRunId,
  openInputs,
  openSignIns,
  workingTaskCalls,
  type SessionInput,
  type SessionProjection,
} from "#protocol/session-projection.js";
import type { RuntimeActionResult } from "#shared/action-types.js";
import type { InputRequest } from "#shared/input.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import type { Transition } from "./commit.js";
import { inputWithdrawn, signInWithdrawn } from "./events.js";
import type { StepCoordinates, SuspendedStep, TurnState } from "./state.js";
import {
  activeTurnId,
  answeredCallIds,
  runningTasks,
  turnPosition,
  type SessionView,
} from "./view.js";

// The session's lifecycle. Every transition reads a `SessionView` and returns the facts that
// report what changed with the execution state that follows; `applyTransition` publishes them as
// one commit and saves the rest, and nothing else builds a lifecycle fact or writes `TurnState`.
// Approvals, the session-limit prompt, and sign-ins are in `approvals.ts`.
//
// When the machine ends something, the same commit ends everything that ends with it: a turn's
// open runs and calls, and the deliveries it answered. Nothing is left for readers to infer.
//
// Transitions are pure: what they need from effects (model responses, tool results, the
// requests a session relays) arrives in their input.

type ToolResponsePart = Extract<ModelMessage, { role: "tool" }>["content"][number];
export type ToolResultPart = Extract<ToolResponsePart, { type: "tool-result" }>;

const unchanged = (view: SessionView, events: readonly SessionEvent[]) => ({
  events,
  turn: view.turn,
});

/** The coordinates the v26 work events still carry. */
function at(projection: SessionProjection) {
  const position = turnPosition(projection);
  return {
    sequence: position.sequence,
    stepIndex: position.stepIndex,
    turnId: activeTurnId(position),
  };
}

/** A delivery a turn consumes, with what the person sent: nothing for an answer or context. */
export interface ConsumedDelivery {
  readonly deliveryId: string;
  readonly parts: readonly UserPart[];
}

/** The turn the next turn follows: the newest, unless a context change chose another or none. */
function followedTurn(projection: SessionProjection): string | null {
  const selection = projection.view?.selection;
  if (selection === null) return null;
  return selection?.turnId ?? projection.latestTurn?.turnId ?? null;
}

/** The deliveries a turn consumed that haven't settled. */
function openDeliveriesOf(projection: SessionProjection, turnId: string): readonly string[] {
  return Object.values(projection.view?.deliveries ?? {})
    .filter((delivery) => delivery.status === "consumed" && delivery.turnId === turnId)
    .map((delivery) => delivery.deliveryId);
}

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

/**
 * Deliveries arrive for a turn: the session starts once, a turn opens unless one is open, and
 * each delivery is consumed into it. A delivery that joins a paused turn resumes it.
 */
export function receive(
  view: SessionView,
  input: {
    readonly deliveries?: readonly ConsumedDelivery[];
    /** What starts the turn when no delivery does. */
    readonly cause?: Cause;
    readonly parent?: { readonly sessionId: string; readonly callId: string };
    readonly runtime?: RuntimeIdentity;
    readonly trace?: RuntimeTraceContext;
  },
): Transition {
  const { projection } = view;
  const position = turnPosition(projection);
  const turnId = activeTurnId(position);
  const deliveries = input.deliveries ?? [];
  const first = deliveries[0];
  const cause: Cause =
    first === undefined ? (input.cause ?? { policy: "system" }) : { deliveryId: first.deliveryId };
  const events: SessionEvent[] = [];
  if (!position.sessionStarted) {
    const data: {
      -readonly [
        K in keyof FactOf<"session.started">["data"]
      ]: FactOf<"session.started">["data"][K];
    } = {};
    if (input.parent !== undefined) data.parent = input.parent;
    if (input.runtime !== undefined) data.runtime = input.runtime;
    if (input.trace !== undefined) data.trace = input.trace;
    events.push({ data, type: "session.started" });
  }
  if (position.turnId === "") {
    const data: {
      -readonly [K in keyof FactOf<"turn.started">["data"]]: FactOf<"turn.started">["data"][K];
    } = {
      cause,
      follows: followedTurn(projection),
      turnId,
    };
    if (input.trace !== undefined) data.trace = input.trace;
    events.push({ data, scope: { turnId }, type: "turn.started" });
  } else if (projection.turns[turnId]?.waiting === true && first !== undefined) {
    events.push({ data: { cause, turnId }, scope: { turnId }, type: "turn.resumed" });
  }
  for (const delivery of deliveries) {
    events.push({
      data: { deliveryId: delivery.deliveryId, parts: delivery.parts, turnId },
      scope: { turnId },
      type: "delivery.consumed",
    });
  }
  return unchanged(view, events);
}

/**
 * Deliveries join the open turn without opening one, as answers do, and resume it if it paused.
 * Between turns an answer has nothing to join: it took effect, and settles `applied`. A delivery
 * already settled, such as one refused, joins nothing.
 */
export function join(
  view: SessionView,
  input: { readonly deliveries: readonly ConsumedDelivery[] },
): Transition {
  const { projection } = view;
  const open = input.deliveries.filter(
    ({ deliveryId }) => projection.view?.deliveries[deliveryId]?.status !== "settled",
  );
  const turnId = projection.activeTurnId;
  if (turnId === undefined) {
    return unchanged(
      view,
      open.map(({ deliveryId }) => ({
        data: { deliveryId, outcome: "applied" },
        type: "delivery.settled",
      })),
    );
  }
  const events: SessionEvent[] = [];
  const first = open[0];
  if (projection.turns[turnId]?.waiting === true && first !== undefined) {
    events.push({
      data: { cause: { deliveryId: first.deliveryId }, turnId },
      scope: { turnId },
      type: "turn.resumed",
    });
  }
  for (const delivery of open) {
    events.push({
      data: { deliveryId: delivery.deliveryId, parts: delivery.parts, turnId },
      scope: { turnId },
      type: "delivery.consumed",
    });
  }
  return unchanged(view, events);
}

/** The open turn needs the model: a run is requested before its model and tools are chosen. */
export function requestModel(view: SessionView): Transition & { readonly runId: string } {
  const { turnId } = at(view.projection);
  const runId = nextRunId(view.projection);
  return {
    ...unchanged(view, [
      { data: { owner: { turnId }, runId }, scope: { runId, turnId }, type: "model.requested" },
    ]),
    runId,
  };
}

/** The run's model was chosen and its provider call begins. */
export function startModel(
  view: SessionView,
  input: { readonly runId: string; readonly modelId: string },
): Transition {
  const owner = view.projection.runs?.[input.runId];
  return unchanged(view, [
    {
      data: { modelId: input.modelId, runId: input.runId },
      scope: runScope(owner, input.runId),
      type: "model.started",
    },
  ]);
}

/** How a run ended, and what it spent. */
export interface RunSettlement {
  readonly runId: string;
  readonly outcome: FactOf<"model.settled">["data"]["outcome"];
  readonly finishReason?: string;
  readonly generationId?: string;
  readonly error?: ErrorInfo;
  readonly usage?: FactOf<"usage.recorded">["data"]["usage"];
}

/** A run settles, with its usage in the same commit. */
export function settleModel(view: SessionView, input: RunSettlement): Transition {
  return unchanged(view, runSettledFacts(view.projection, input));
}

function runSettledFacts(projection: SessionProjection, input: RunSettlement): SessionEvent[] {
  const owner = projection.runs?.[input.runId];
  const scope = runScope(owner, input.runId);
  const data: {
    -readonly [K in keyof FactOf<"model.settled">["data"]]: FactOf<"model.settled">["data"][K];
  } = {
    outcome: input.outcome,
    runId: input.runId,
  };
  if (input.finishReason !== undefined) data.finishReason = input.finishReason;
  if (input.generationId !== undefined) data.generationId = input.generationId;
  if (input.error !== undefined) data.error = input.error;
  const facts: SessionEvent[] = [{ data, scope, type: "model.settled" }];
  if (input.usage !== undefined) {
    facts.push({
      data: { kind: "model", owner: { runId: input.runId }, usage: input.usage },
      scope,
      type: "usage.recorded",
    });
  }
  return facts;
}

function runScope(
  owner: { readonly turnId?: string; readonly changeId?: string } | undefined,
  runId: string,
) {
  const scope: { runId: string; turnId?: string; changeId?: string } = { runId };
  if (owner?.turnId !== undefined) scope.turnId = owner.turnId;
  if (owner?.changeId !== undefined) scope.changeId = owner.changeId;
  return scope;
}

/**
 * The open turn pauses: on `"tasks"` while work it started runs, on `"input"` while a person must
 * act on a sign-in, approval, or question. A pause on a person answers its deliveries for now
 * (`awaiting-input`); the answer's delivery carries the resumed work.
 */
export function hold(view: SessionView, input: { readonly on: "input" | "tasks" }): Transition {
  const { projection } = view;
  const { turnId } = turnPosition(projection);
  if (turnId === "") return unchanged(view, []);
  const awaiting: TurnAwaiting[] =
    input.on === "tasks"
      ? [...new Set(workingTaskCalls(projection).map((call) => call.callId))].map((callId) => ({
          callId,
        }))
      : [
          ...openInputs(projection).map((open) => ({ interactionId: open.request.requestId })),
          ...openSignIns(projection).map((attempt) => ({ interactionId: attempt.attemptId })),
        ];
  const events: SessionEvent[] = [
    { data: { awaiting, turnId }, scope: { turnId }, type: "turn.paused" },
  ];
  if (input.on === "input") {
    for (const deliveryId of openDeliveriesOf(projection, turnId)) {
      events.push({
        data: { deliveryId, outcome: "awaiting-input", turnId },
        type: "delivery.settled",
      });
    }
  }
  return unchanged(view, events);
}

/** How a turn ends. */
interface TurnEnding {
  readonly outcome: FactOf<"turn.settled">["data"]["outcome"];
  readonly cause?: Cause;
  readonly error?: ErrorInfo;
  /** Why the turn's open calls stopped. */
  readonly reason: string;
}

/**
 * The facts that end the open turn, in one commit: its open runs and calls, the turn, and the
 * deliveries it answered.
 */
function closeTurn(projection: SessionProjection, ending: TurnEnding): SessionEvent[] {
  const turnId = projection.activeTurnId;
  if (turnId === undefined) return [];
  const facts: SessionEvent[] = [];
  for (const [runId, run] of Object.entries(projection.runs ?? {})) {
    if (run.turnId !== turnId) continue;
    facts.push(
      ...runSettledFacts(projection, {
        error: ending.outcome === "failed" ? ending.error : undefined,
        outcome: ending.outcome === "failed" ? "failed" : "interrupted",
        runId,
      }),
    );
  }
  for (const call of Object.values(projection.calls)) {
    if (call.turnId !== turnId || call.taskId !== undefined || call.status !== "running") continue;
    facts.push({
      data: { callId: call.callId, outcome: "interrupted", reason: ending.reason },
      scope: { turnId },
      type: "call.settled",
    });
  }
  const turn = projection.turns[turnId];
  const data: {
    -readonly [K in keyof FactOf<"turn.settled">["data"]]: FactOf<"turn.settled">["data"][K];
  } = {
    outcome: ending.outcome,
    turnId,
  };
  if (turn?.reply !== undefined && turn.reply.length > 0) data.reply = turn.reply;
  if (ending.cause !== undefined) data.cause = ending.cause;
  if (ending.error !== undefined) data.error = ending.error;
  facts.push({ data, scope: { turnId }, type: "turn.settled" });
  for (const deliveryId of openDeliveriesOf(projection, turnId)) {
    facts.push({ data: { deliveryId, outcome: "handled", turnId }, type: "delivery.settled" });
  }
  return facts;
}

/** Nothing is left to run: the turn completes. */
export function finishTurn(view: SessionView): Transition {
  return unchanged(
    view,
    closeTurn(view.projection, { outcome: "completed", reason: "turn-ended" }),
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
    readonly terminal?: { readonly sessionId: string };
  },
): Transition {
  // The calls the turn approved but hadn't run never run: the model reads that they stopped.
  const stopped = view.turn.suspended.filter((step) => (step.approved?.length ?? 0) > 0);
  const errorId = failure.details?.errorId;
  const error: ErrorInfo =
    typeof errorId === "string"
      ? { code: failure.code, id: errorId, message: failure.message }
      : { code: failure.code, message: failure.message };
  const turnId = view.projection.activeTurnId;
  const events = closeTurn(view.projection, { error, outcome: "failed", reason: "turn-failed" });
  if (failure.terminal !== undefined) {
    events.push(
      ...sessionEndedFacts(view.projection, {
        cause: turnId === undefined ? undefined : { turnId },
        error,
        outcome: "failed",
      }),
    );
  }
  return {
    commit: stopped.flatMap(cancelledTranscript),
    events,
    turn: {
      ...view.turn,
      suspended: view.turn.suspended.filter((step) => !stopped.includes(step)),
    },
  };
}

/** The session waits for its next delivery. Nothing is written: readers ask `idle`. */
export function idle(view: SessionView): Transition {
  return unchanged(view, []);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * The facts that end a session: every delivery it hasn't settled fails, an open context change
 * is interrupted, and `session.ended` is last. Every reader stops there.
 */
export function sessionEndedFacts(
  projection: SessionProjection | undefined,
  ending: {
    readonly outcome: "completed" | "failed";
    readonly cause?: Cause;
    readonly error?: ErrorInfo;
  },
): SessionEvent[] {
  const facts: SessionEvent[] = [];
  for (const delivery of Object.values(projection?.view?.deliveries ?? {})) {
    if (delivery.status === "settled") continue;
    facts.push({
      data: { deliveryId: delivery.deliveryId, outcome: "failed", reason: "session-ended" },
      type: "delivery.settled",
    });
  }
  for (const change of Object.values(projection?.view?.changes ?? {})) {
    if (change.status !== "running") continue;
    facts.push({
      data: { changeId: change.changeId, kind: change.kind, outcome: "interrupted" },
      type: "context.settled",
    });
  }
  const data: {
    -readonly [K in keyof FactOf<"session.ended">["data"]]: FactOf<"session.ended">["data"][K];
  } = {
    outcome: ending.outcome,
  };
  if (ending.cause !== undefined) data.cause = ending.cause;
  if (ending.error !== undefined) data.error = ending.error;
  facts.push({ data, type: "session.ended" });
  return facts;
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

/** One call's result, ready for its step's transcript. */
export interface SettledCall {
  readonly part: ToolResultPart;
  /** A runtime result, reported at the coordinates of the step that made the call. */
  readonly result?: RuntimeActionResult;
}

/**
 * Results reach the steps that made their calls. A step whose every call now has a result
 * commits to history, where the model reads it.
 */
export function settle(view: SessionView, input: { readonly results: readonly SettledCall[] }) {
  const events: SessionEvent[] = [];
  const steps = [...view.turn.suspended];
  for (const { part, result } of input.results) {
    const index = steps.findIndex((step) => stepCallIds(step).has(part.toolCallId));
    const step = steps[index];
    if (step === undefined) continue;
    steps[index] = withoutApproved(
      { ...step, messages: withResult(step.messages, part) },
      new Set([part.toolCallId]),
    );
    if (result !== undefined) {
      events.push(callSettledFrom(result, { scope: { turnId: step.event.turnId } }));
    }
  }
  // A step that parked approvals beside its tasks asks for them once the tasks finish.
  for (const step of steps) {
    if (step.tasks.length === 0 || step.requests.length === 0) continue;
    if (runningTasks(step).length > 0) continue;
    if (step.requests.some((request) => request.requestId in view.projection.inputs)) continue;
    events.push(createInputRequestedEvent({ requests: step.requests, ...step.event }));
  }
  const complete = steps.filter(isComplete);
  return {
    commit: complete.flatMap((step) => step.messages),
    events,
    turn: { ...view.turn, suspended: steps.filter((step) => !complete.includes(step)) },
  } satisfies Transition;
}

/** A call a discarded model-call attempt announced without a result. */
export interface DiscardedCall {
  readonly callId: string;
  readonly toolName: string;
}

/**
 * A model-call attempt failed after the stream accepted output, and the step retries it in a new
 * run. eve can't tell whether the calls the attempt announced ran, so each settles `abandoned`,
 * and so does the run; nothing reaches history, since the discarded response was never committed.
 */
export function discardAttempt(
  view: SessionView,
  input: {
    readonly calls: readonly DiscardedCall[];
    readonly runId?: string;
    /** `interrupted` when steering cut the attempt off; `abandoned` when a retry replaces it. */
    readonly outcome?: "abandoned" | "interrupted";
  },
): Transition {
  const { turnId } = at(view.projection);
  const outcome = input.outcome ?? "abandoned";
  const reason = outcome === "abandoned" ? "model-call-retried" : "steered";
  const events: SessionEvent[] = input.calls.map(({ callId }) => ({
    data: { callId, outcome, reason },
    scope: { turnId },
    type: "call.settled",
  }));
  if (input.runId !== undefined && view.projection.runs?.[input.runId] !== undefined) {
    events.push(...runSettledFacts(view.projection, { outcome: "abandoned", runId: input.runId }));
  }
  return unchanged(view, events);
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
  const approved = step.approved.filter((request) => !callIds.has(request.action.callId));
  if (approved.length === step.approved.length) return step;
  const { approved: _approved, ...rest } = step;
  return approved.length === 0 ? rest : { ...rest, approved };
}

/** Approved calls of suspended steps that haven't run. */
export function approvedCalls(turn: TurnState): readonly InputRequest[] {
  return turn.suspended.flatMap((step) => step.approved ?? []);
}

export function suspend(turn: TurnState, step: SuspendedStep): TurnState {
  return { ...turn, suspended: [...turn.suspended, step] };
}

/** The ids of the calls a step's response made, except provider-executed ones. */
export function stepCallIds(step: Pick<SuspendedStep, "messages">): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const message of step.messages) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "tool-call" && part.providerExecuted !== true) ids.add(part.toolCallId);
    }
  }
  return ids;
}

function isComplete(step: SuspendedStep): boolean {
  if (step.requests.length > 0) return false;
  const answered = answeredCallIds(step.messages);
  return [...stepCallIds(step)].every((callId) => answered.has(callId));
}

/**
 * Places a result right after the message that made its call, under the call's name: a call
 * made through `eve__tool` or `eve__skill` keeps that name in history, whatever entry it ran.
 */
export function withResult(
  messages: readonly ModelMessage[],
  result: ToolResultPart,
): ModelMessage[] {
  const next = [...messages];
  const asking = findCall(next, result.toolCallId);
  if (asking === undefined) {
    next.push({ content: [result], role: "tool" });
    return next;
  }
  const part = { ...result, toolName: asking.call.toolName };
  const following = next[asking.index + 1];
  if (following?.role === "tool") {
    next[asking.index + 1] = { ...following, content: [...following.content, part] };
  } else {
    next.splice(asking.index + 1, 0, { content: [part], role: "tool" });
  }
  return next;
}

/** The call with this id, and the index of the message that made it. */
function findCall(
  messages: readonly ModelMessage[],
  callId: string,
): { readonly call: ToolCallPart; readonly index: number } | undefined {
  for (const [index, message] of messages.entries()) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    const call = message.content.find(
      (content): content is ToolCallPart =>
        content.type === "tool-call" && content.toolCallId === callId,
    );
    if (call !== undefined) return { call, index };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/** A call started or reached a task. */
export function startTask(view: SessionView, task: TaskStartedStreamEvent["data"]): Transition {
  return unchanged(view, [createTaskStartedEvent(task)]);
}

export type TaskCallOutcome =
  | { readonly status: "completed"; readonly output?: JsonValue }
  | { readonly status: "failed"; readonly error: string }
  | { readonly status: "cancelled"; readonly reason?: TaskCancelReason };

/** A task's run settled calls: each reports its outcome, naming the task as it started. */
export function settleTask(
  view: SessionView,
  input: {
    readonly task: {
      readonly id: string;
      readonly kind?: TaskStartedStreamEvent["data"]["kind"];
      readonly name?: string;
    };
    readonly calls: readonly { readonly callId: string; readonly turnId: string }[];
    readonly outcome: TaskCallOutcome;
  },
): Transition {
  const { outcome, task } = input;
  const settled = input.calls.map((call): SessionEvent => {
    const data: {
      -readonly [K in keyof FactOf<"call.settled">["data"]]: FactOf<"call.settled">["data"][K];
    } = {
      callId: call.callId,
      outcome:
        outcome.status === "completed"
          ? "completed"
          : outcome.status === "failed"
            ? "failed"
            : "interrupted",
    };
    if (outcome.status === "completed" && outcome.output !== undefined)
      data.output = outcome.output;
    if (outcome.status === "failed") data.error = { code: "TASK_FAILED", message: outcome.error };
    if (outcome.status === "cancelled") data.reason = outcome.reason ?? "task-cancelled";
    return { data, scope: { taskId: task.id, turnId: call.turnId }, type: "call.settled" };
  });
  return unchanged(view, [
    ...input.calls.map((call) => {
      const base = {
        callId: call.callId,
        kind: task.kind,
        name: task.name,
        taskId: task.id,
        turnId: call.turnId,
      };
      switch (outcome.status) {
        case "completed":
          return createTaskSettledEvent({ ...base, output: outcome.output, status: "completed" });
        case "failed":
          return createTaskSettledEvent({
            ...base,
            error: { message: outcome.error },
            status: "failed",
          });
        case "cancelled":
          return createTaskSettledEvent(
            outcome.reason === undefined
              ? { ...base, status: "cancelled" }
              : { ...base, cancel: { reason: outcome.reason }, status: "cancelled" },
          );
      }
    }),
    ...settled,
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
  return unchanged(
    view,
    openInputs(view.projection)
      .filter(
        (input) =>
          ids.has(input.request.requestId) ||
          (run.taskId !== undefined && input.taskId === run.taskId),
      )
      .map(inputWithdrawn),
  );
}

// ---------------------------------------------------------------------------
// Relay
// ---------------------------------------------------------------------------

/**
 * A child session or workflow run asks a question or for a sign-in. The session passes it up
 * with its original coordinates, and the open turn waits on the call it serves.
 * A child's fresh batch replaces its earlier one, whose open requests are withdrawn.
 */
export function relay(
  view: SessionView,
  input: {
    readonly payload: SubagentInputRequestHookPayload | SubagentAuthorizationEventHookPayload;
    readonly replacedRequestIds?: Iterable<string>;
  },
): Transition {
  const { payload } = input;
  const events: SessionEvent[] = [
    ...finishRun(view, { requestIds: input.replacedRequestIds }).events,
  ];
  if (payload.kind === "subagent-input-request") {
    const { event } = payload;
    events.push(
      createInputRequestedEvent({
        callId: payload.callId,
        requests: event.requests,
        sequence: event.sequence,
        stepIndex: event.stepIndex,
        taskId: event.taskId,
        turnId: event.turnId,
      }),
    );
  } else {
    const { event } = payload;
    events.push(event);
    if (event.type !== "authorization.required") return unchanged(view, events);
  }
  events.push(...hold(view, { on: "input" }).events);
  return unchanged(view, events);
}

/**
 * A person's message answered a request this session relays: the session records the delivery,
 * consumed into the turn that asked, while the answer goes on to the asker.
 */
export function receiveRelayedAnswer(input: {
  readonly deliveryIds: readonly string[];
  readonly parts: readonly UserPart[];
  readonly turnId: string;
}): SessionEvent[] {
  return input.deliveryIds.flatMap((deliveryId): SessionEvent[] => [
    { data: { deliveryId }, type: "delivery.admitted" },
    {
      data: { deliveryId, parts: input.parts, turnId: input.turnId },
      scope: { turnId: input.turnId },
      type: "delivery.consumed",
    },
  ]);
}

export function routeAnswer(
  view: SessionView,
  input: {
    readonly children: readonly {
      readonly event: StepCoordinates;
      readonly resolutions: readonly InputResolution[];
    }[];
  },
): Transition {
  const events: SessionEvent[] = input.children
    .filter((child) => child.resolutions.length > 0)
    .map((child) => createInputResolvedEvent({ resolutions: child.resolutions, ...child.event }));
  return unchanged(view, events);
}

/**
 * A workflow run's sign-in, reported to the session that owns the run, which relays it. Built
 * where the run asks, at the coordinates of the call it serves.
 */
export function runSignIn(
  from: {
    readonly sequence: number;
    readonly stepIndex: number;
    readonly taskId?: string;
    readonly turnId: string;
  },
  challenge: AuthorizationChallenge,
  outcome?: "authorized" | "failed",
) {
  const fields = {
    ...authorizationEventFields(challenge),
    sequence: from.sequence,
    stepIndex: from.stepIndex,
    taskId: from.taskId,
    turnId: from.turnId,
  };
  return outcome === undefined
    ? createAuthorizationRequiredEvent({
        ...fields,
        description: `Sign in to ${challenge.name} to continue.`,
        webhookUrl: challenge.hookUrl,
      })
    : createAuthorizationCompletedEvent({ ...fields, outcome });
}

// ---------------------------------------------------------------------------
// Sign-ins
// ---------------------------------------------------------------------------

/** Sign-in callbacks arrived: each completion is reported at the coordinates of the turn that asked. */
export function completeSignIn(
  view: SessionView,
  input: { readonly completions: readonly AuthorizationChallenge[] },
): Transition {
  const position = at(view.projection);
  return unchanged(
    view,
    input.completions.map((challenge) => {
      const attempt =
        challenge.attemptId === undefined
          ? undefined
          : view.projection.authorizations[challenge.attemptId];
      return createAuthorizationCompletedEvent({
        ...authorizationEventFields(challenge),
        outcome: "authorized",
        sequence: attempt?.sequence ?? position.sequence,
        stepIndex: attempt?.stepIndex ?? position.stepIndex,
        turnId: attempt?.turnId ?? position.turnId,
      });
    }),
  );
}

// ---------------------------------------------------------------------------
// Cancel and clear
// ---------------------------------------------------------------------------

/** Requests this session asked itself and still awaits; relayed requests answer elsewhere. */
export function ownOpenRequestIds(view: Omit<SessionView, "turn">): ReadonlySet<string> {
  return new Set(
    openInputs(view.projection)
      .filter(
        (input) =>
          input.callId === undefined &&
          input.taskId === undefined &&
          !view.relayedRequestIds.has(input.request.requestId),
      )
      .map((input) => input.request.requestId),
  );
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
  const turnId = projection.activeTurnId;
  const stopped = view.turn.suspended.filter(
    (step) =>
      (turnId !== undefined && step.event.turnId === turnId) ||
      step.tasks.some((task) => !answeredCallIds(step.messages).has(task.callId)) ||
      (step.approved?.length ?? 0) > 0,
  );
  const stoppedRequestIds = new Set(
    stopped.flatMap((step) => step.requests.map((request) => request.requestId)),
  );
  const owned = (input: SessionInput) =>
    input.turnId === turnId ||
    stoppedRequestIds.has(input.request.requestId) ||
    view.relayedRequestIds.has(input.request.requestId) ||
    input.request.kind === "session-limit";
  const events: SessionEvent[] = [
    ...openInputs(projection).filter(owned).map(inputWithdrawn),
    ...openSignIns(projection)
      .filter((attempt) => attempt.turnId === turnId)
      .map((attempt) => signInWithdrawn(attempt, "Cancelled.")),
  ];
  events.push(
    ...closeTurn(projection, {
      cause: input.cause,
      outcome: "cancelled",
      reason: "turn-cancelled",
    }),
  );
  return {
    commit: stopped.flatMap(cancelledTranscript),
    events,
    // Every sign-in the turn held ends with it.
    signIns: [],
    turn: {
      ...view.turn,
      suspended: view.turn.suspended.filter((step) => !stopped.includes(step)),
    },
  };
}

/** A stopped step's response, each call without a result answered as cancelled. */
function cancelledTranscript(step: SuspendedStep): ModelMessage[] {
  const answered = answeredCallIds(step.messages);
  let messages = [...step.messages];
  for (const message of step.messages) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type !== "tool-call" || part.providerExecuted === true) continue;
      if (answered.has(part.toolCallId)) continue;
      messages = withResult(messages, {
        output: { type: "text", value: CANCELLED_CALL_RESULT },
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
export function clear(
  view: SessionView,
  input: { readonly sessionId: string; readonly cause?: Cause },
): Transition {
  const { projection } = view;
  const changeId = nextChangeId(projection);
  return {
    clearsHistory: true,
    events: [
      ...openInputs(projection)
        .filter((open) => !view.relayedRequestIds.has(open.request.requestId))
        .map(inputWithdrawn),
      ...openSignIns(projection).map((attempt) =>
        signInWithdrawn(attempt, "The context was cleared."),
      ),
      contextStarted({ cause: input.cause, changeId, kind: "clear" }),
      {
        data: { changeId, kind: "clear", outcome: "completed", selects: null },
        type: "context.settled",
      },
    ],
    turn: { grants: view.turn.grants, suspended: [] } satisfies TurnState,
  };
}

/** A context change starts. */
export function contextStarted(input: {
  readonly changeId: string;
  readonly kind: string;
  readonly turnId?: string;
  readonly cause?: Cause;
  readonly trigger?: { readonly inputTokens: number };
}): FactOf<"context.started"> {
  const data: {
    -readonly [K in keyof FactOf<"context.started">["data"]]: FactOf<"context.started">["data"][K];
  } = {
    changeId: input.changeId,
    kind: input.kind,
  };
  if (input.turnId !== undefined) data.turnId = input.turnId;
  if (input.cause !== undefined) data.cause = input.cause;
  if (input.trigger !== undefined) data.trigger = input.trigger;
  return input.turnId === undefined
    ? { data, scope: { changeId: input.changeId }, type: "context.started" }
    : { data, scope: { changeId: input.changeId, turnId: input.turnId }, type: "context.started" };
}
