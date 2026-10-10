import type { ModelMessage, ToolCallPart } from "ai";

import type {
  SubagentAuthorizationEventHookPayload,
  SubagentInputRequestHookPayload,
} from "#channel/types.js";
import type { AuthorizationChallenge } from "#harness/authorization.js";
import { callSettledFrom } from "#harness/call-facts.js";
import { closeFacts, closureFor, notIn, publicViewOf } from "#harness/session-machine/closure.js";
import {
  activeTurn,
  callTask,
  callTurn,
  interactionOwner,
  noWork,
  type OpenWork,
  openWork,
} from "#protocol/session-projection/selectors.js";
import type {
  InputResolution,
  RuntimeIdentity,
  RuntimeTraceContext,
  SessionPredecessor,
  TaskCancelReason,
} from "#protocol/message.js";
import {
  interactionOpened,
  interactionSettled,
  responseSettled,
  responseSubmitted,
  signInInteractionId,
  signInOpened,
} from "#harness/interaction-facts.js";
import type {
  DeliveryAdmittedData,
  DeliverySource,
} from "#protocol/session-events/families/delivery.js";
import type { ControlDelivery } from "#harness/types.js";
import type { ResponseSubmittedData } from "#protocol/session-events/families/response.js";
import type { SessionEvent } from "#protocol/session-event.js";
import type {
  Cause,
  ErrorInfo,
  Principal,
  Usage,
  UserPart,
} from "#protocol/session-events/envelope.js";
import type { TokenUsage } from "#shared/token-usage.js";
import type { FactOf } from "#protocol/session-events/facts.js";
import type { TurnAwaiting } from "#protocol/session-events/families/turn.js";
import {
  nextChangeId,
  nextRunId,
  openRequests,
  workingTaskCalls,
  type SessionProjection,
} from "#protocol/session-projection.js";
import type { RuntimeActionResult } from "#shared/action-types.js";
import type { InputRequest, InputResponse } from "#shared/input.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import type { Transition } from "./commit.js";
import { signInAttemptKey } from "#harness/hitl/sign-ins.js";
import { toProxyInputRequestEntries, type WorkflowAskRoute } from "#harness/hitl/relays.js";
import type { SuspendedStep, TurnState } from "./state.js";
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
    /** The session this one replaced, when eve started it in place of a stranded one. */
    readonly predecessor?: SessionPredecessor;
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
    if (input.predecessor !== undefined) data.predecessor = input.predecessor;
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
export function hold(
  view: SessionView,
  input: {
    readonly on: "input" | "tasks";
    /** Interactions this commit opens, which the tables don't hold yet. */
    readonly opening?: readonly string[];
  },
): Transition {
  const { projection } = view;
  const { turnId } = turnPosition(projection);
  if (turnId === "") return unchanged(view, []);
  const awaiting: TurnAwaiting[] =
    input.on === "tasks"
      ? [...new Set(workingTaskCalls(projection).map((call) => call.callId))].map((callId) => ({
          callId,
        }))
      : [
          ...new Set([
            ...openWork(publicViewOf(projection), { turnId }).interactions.map(
              (row) => row.interactionId,
            ),
            ...(input.opening ?? []),
          ]),
        ].map((interactionId) => ({ interactionId }));
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
}

/**
 * The facts that end the open turn, in one commit: what it leaves open, the turn, and the
 * deliveries it answered.
 */
function closeTurn(projection: SessionProjection, ending: TurnEnding): SessionEvent[] {
  const turnId = activeTurn(publicViewOf(projection))?.turnId ?? projection.activeTurnId;
  return turnId === undefined ? [] : turnClosure(projection, turnId, ending).facts;
}

function turnClosure(
  projection: SessionProjection,
  turnId: string,
  ending: TurnEnding,
): { readonly facts: SessionEvent[]; readonly closed: OpenWork } {
  const tables = publicViewOf(projection);
  const open = openWork(tables, { turnId });
  const closure = closureFor({ error: ending.error, turn: ending.outcome });
  const { deliveries, work } = closeFacts(tables, open, closure);
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
  return {
    closed: open,
    facts: [...work, { data, scope: { turnId }, type: "turn.settled" }, ...deliveries],
  };
}

/** Nothing is left to run: the turn completes. */
export function finishTurn(view: SessionView): Transition {
  return unchanged(view, closeTurn(view.projection, { outcome: "completed" }));
}

/** A failure as the stream reports it: its code and message, with its support id and remedy. */
export function errorInfoOf(failure: {
  readonly code: string;
  readonly details?: JsonObject;
  readonly message: string;
}): ErrorInfo {
  const error: { -readonly [K in keyof ErrorInfo]: ErrorInfo[K] } = {
    code: failure.code,
    message: failure.message,
  };
  const { errorId, hint } = failure.details ?? {};
  if (typeof errorId === "string") error.id = errorId;
  if (typeof hint === "string" && hint.trim().length > 0) error.hint = hint.trim();
  return error;
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
  const error = errorInfoOf(failure);
  const turnId = view.projection.activeTurnId;
  // A terminal failure ends the session, which ends the turn with it, in one commit.
  const events =
    failure.terminal === undefined
      ? closeTurn(view.projection, { error, outcome: "failed" })
      : sessionEndedFacts(view.projection, {
          cause: turnId === undefined ? undefined : { turnId },
          error,
          outcome: "failed",
        });
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
 * The facts that end a session, in one commit: an open turn ends first (failed with the session's
 * error, or cancelled), then everything else the session leaves open, and `session.ended` is
 * last. Every reader stops there.
 */
export function sessionEndedFacts(
  projection: SessionProjection | undefined,
  ending: {
    readonly outcome: "completed" | "failed";
    readonly cause?: Cause;
    /** The reset control that ends the session: admitted first, applied before the end. */
    readonly control?: ControlDelivery;
    readonly error?: ErrorInfo;
  },
): SessionEvent[] {
  const facts: SessionEvent[] = [];
  const { control } = ending;
  if (control !== undefined) facts.push(controlAdmitted(control, "reset"));
  let closed: OpenWork = noWork();
  const tables = publicViewOf(projection);
  // The shared tables, not an execution pointer, decide which turns are still open. This
  // also works for degraded terminal publication from a checkpoint without live turn state.
  if (projection !== undefined) {
    for (const row of Object.values(tables.turns)) {
      if (row.status === "settled") continue;
      const turn = turnClosure(projection, row.turnId, {
        error: ending.error,
        outcome: ending.outcome === "failed" ? "failed" : "cancelled",
      });
      facts.push(...turn.facts);
      closed = {
        calls: [...closed.calls, ...turn.closed.calls],
        changes: [...closed.changes, ...turn.closed.changes],
        deliveries: [...closed.deliveries, ...turn.closed.deliveries],
        runs: [...closed.runs, ...turn.closed.runs],
        tasks: [...closed.tasks, ...turn.closed.tasks],
        interactions: [...closed.interactions, ...turn.closed.interactions],
        responses: [...closed.responses, ...turn.closed.responses],
      };
    }
  }
  const rest = notIn(openWork(tables, { session: true }), closed);
  const { deliveries, work } = closeFacts(
    tables,
    rest,
    closureFor({ error: ending.error, session: ending.outcome }),
  );
  facts.push(...work, ...deliveries);
  if (control !== undefined) facts.push(deliveryApplied(control.deliveryId));
  const data: {
    -readonly [K in keyof FactOf<"session.ended">["data"]]: FactOf<"session.ended">["data"][K];
  } = {
    outcome: ending.outcome,
  };
  const cause = control === undefined ? ending.cause : { deliveryId: control.deliveryId };
  if (cause !== undefined) data.cause = cause;
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
  /** What the agent behind the call spent, which its settlement records. */
  readonly usage?: TokenUsage;
}

/** What the agent behind a call spent, recorded against the call. */
export function delegatedUsageFact(
  callId: string,
  usage: TokenUsage,
  scope: { readonly turnId: string },
): SessionEvent {
  const recorded: { -readonly [K in keyof Usage]: Usage[K] } = {
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  };
  if (usage.costUsd !== undefined) recorded.costUsd = usage.costUsd;
  return {
    data: { kind: "model", owner: { callId }, usage: recorded },
    scope,
    type: "usage.recorded",
  };
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
    const recorded =
      result === undefined ? undefined : publicViewOf(view.projection).calls[result.callId];
    if (result !== undefined && recorded?.taskId === undefined && recorded?.status !== "settled") {
      // A task's start receipt is model history only. Its public call stays open until the
      // task replies; the reply path publishes its actual settlement and delegated spend.
      const scope = { turnId: step.event.turnId };
      events.push(callSettledFrom(result, { scope }));
      // A child's usage counts once, in the commit that settles its call.
      if (usage !== undefined) events.push(delegatedUsageFact(result.callId, usage, scope));
    }
  }
  // A step that parked approvals beside its tasks asks for them once the tasks finish.
  for (const step of steps) {
    if (step.tasks.length === 0 || step.requests.length === 0) continue;
    if (runningTasks(step).length > 0) continue;
    const tables = publicViewOf(view.projection);
    if (step.requests.some((request) => tables.interactions[request.requestId] !== undefined))
      continue;
    events.push(
      ...step.requests.map((request) =>
        interactionOpened(request, { scope: { turnId: step.event.turnId } }),
      ),
    );
  }
  const complete = steps.filter(isComplete);
  return {
    commit: complete.flatMap((step) => step.messages),
    events,
    turn: { ...view.turn, suspended: steps.filter((step) => !complete.includes(step)) },
  } satisfies Transition;
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
  const tables = publicViewOf(view.projection);
  const open = openWork(tables, { runId: input.runId });
  const { work } = closeFacts(tables, { ...open, runs: [] }, closureFor({ attempt: input.ending }));
  if (open.runs.length === 0) return unchanged(view, work);
  const run =
    input.ending === "retried"
      ? { outcome: "abandoned" as const, runId: input.runId, usage: input.usage }
      : {
          finishReason: "other",
          outcome: "completed" as const,
          runId: input.runId,
          usage: input.usage,
        };
  return unchanged(view, [...work, ...runSettledFacts(view.projection, run)]);
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

/** Private dispatch metadata for a call that starts or reaches a task. */
export interface TaskCallStart {
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
  const scope = { taskId: task.taskId, turnId: task.turnId };
  const events: SessionEvent[] = [];
  const introduced =
    introducedTasks?.has(task.taskId) ??
    publicViewOf(view.projection).tasks[task.taskId] !== undefined;
  if (!introduced) {
    introducedTasks?.add(task.taskId);
    events.push({
      type: "task.started",
      scope,
      data: {
        taskId: task.taskId,
        kind: task.kind,
        name: task.name,
        startedBy: { callId: task.callId },
      },
    });
  }
  events.push({ type: "call.started", scope, data: { callId: task.callId, taskId: task.taskId } });
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
    readonly task: {
      readonly id: string;
      readonly kind?: TaskCallStart["kind"];
      readonly name?: string;
    };
    readonly calls: readonly { readonly callId: string; readonly turnId: string }[];
    readonly outcome: TaskCallOutcome;
  },
): Transition {
  const { outcome, task } = input;
  const settled = input.calls.map((call, index): SessionEvent => {
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
    if (outcome.status === "completed" && outcome.output !== undefined) {
      const first = input.calls[0];
      if (index === 0 || first === undefined) data.output = outcome.output;
      else data.outputOf = { callId: first.callId };
    }
    if (outcome.status === "failed") data.error = { code: "TASK_FAILED", message: outcome.error };
    if (outcome.status === "cancelled") data.reason = outcome.reason ?? "task-cancelled";
    return { data, scope: { taskId: task.id, turnId: call.turnId }, type: "call.settled" };
  });
  return unchanged(view, settled);
}

/** A task's body ended. Replying only settles calls; it never ends a resumable task. */
export function endTask(
  view: SessionView,
  input: {
    readonly taskId: string;
    readonly outcome: TaskCallOutcome;
    /** Calls whose actual outcomes precede this task terminal in the same commit. */
    readonly closedCallIds?: readonly string[];
    /** Interactions an earlier commit of the same step already withdrew. */
    readonly closedInteractionIds?: readonly string[];
  },
): Transition {
  const tables = publicViewOf(view.projection);
  const row = tables.tasks[input.taskId];
  if (row === undefined || row.status === "ended") return unchanged(view, []);
  const { outcome } = input;
  const open = openWork(tables, { taskId: input.taskId });
  const closed = new Set(input.closedCallIds);
  const withdrawn = new Set(input.closedInteractionIds);
  const remaining = {
    ...open,
    calls: open.calls.filter((call) => !closed.has(call.callId)),
    interactions: open.interactions.filter((row) => !withdrawn.has(row.interactionId)),
    responses: open.responses.filter((row) => !withdrawn.has(row.interactionId)),
  };
  const closure = closureFor({
    task: outcome.status,
    error:
      outcome.status === "failed" ? { code: "TASK_FAILED", message: outcome.error } : undefined,
    reason: outcome.status === "cancelled" ? outcome.reason : undefined,
  });
  return unchanged(view, closeFacts(tables, remaining, closure).work);
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
  const tables = publicViewOf(view.projection);
  const withdrawn = Object.values(tables.interactions).filter(
    (row) =>
      row.status === "open" &&
      (ids.has(row.interactionId) ||
        (run.taskId !== undefined && interactionOwner(tables, row).taskId === run.taskId)),
  );
  return unchanged(
    view,
    withdrawn.flatMap((row) => withdrawInteraction(tables, row.interactionId, "asker-ended")),
  );
}

/** An interaction nobody needs anymore, with the answers still open on it. */
function withdrawInteraction(
  tables: ReturnType<typeof publicViewOf>,
  interactionId: string,
  reason: string,
  outcome: "withdrawn" | "interrupted" = "withdrawn",
): SessionEvent[] {
  const row = tables.interactions[interactionId];
  if (row === undefined || row.status !== "open") return [];
  const owner = interactionOwner(tables, row);
  const scope: { turnId?: string; taskId?: string } = {};
  if (owner.turnId !== undefined) scope.turnId = owner.turnId;
  if (owner.taskId !== undefined) scope.taskId = owner.taskId;
  return [
    ...Object.values(tables.responses)
      .filter(
        (response) => response.interactionId === interactionId && response.status !== "settled",
      )
      .map((response) => responseSettled(response.responseId, "withdrawn", reason)),
    interactionSettled(interactionId, outcome, { reason, scope }),
  ];
}

// ---------------------------------------------------------------------------
// Relay
// ---------------------------------------------------------------------------

/**
 * A child session or workflow run asks a question or for a sign-in, or reports how it settled
 * one. The session mirrors each as its own interaction, about the call it serves; a child
 * session's names the child's request as its origin. A child's fresh batch replaces its earlier
 * one, whose open requests are withdrawn. The open turn waits on a request about one of its
 * calls; a task's request waits on the task.
 */
export function relay(
  view: SessionView,
  input: {
    readonly payload: SubagentInputRequestHookPayload | SubagentAuthorizationEventHookPayload;
    readonly replacedRequestIds?: Iterable<string>;
    /** The workflow tool run that relays the request, and the hook its `ctx.ask()` answers reach. */
    readonly runId?: string;
    readonly workflowAsk?: WorkflowAskRoute;
  },
): Transition {
  const { payload } = input;
  const tables = publicViewOf(view.projection);
  const events: SessionEvent[] = [
    ...finishRun(view, { requestIds: input.replacedRequestIds }).events,
  ];
  const serving = tables.calls[payload.callId];
  const scope: { turnId?: string; taskId?: string } = {};
  const turnId =
    (serving === undefined ? undefined : callTurn(tables, serving)) ??
    (payload.kind === "subagent-input-request" ? payload.event.turnId : undefined);
  const taskId =
    (serving === undefined ? undefined : callTask(tables, serving)) ??
    (payload.kind === "subagent-input-request" ? payload.event.taskId : undefined);
  if (turnId !== undefined && turnId !== "") scope.turnId = turnId;
  if (taskId !== undefined) scope.taskId = taskId;
  // The asker: a child session, or the workflow tool run that asked, by its run id. Every
  // relayed request names it, so readers tell it apart from this session's own requests.
  const origin = (interactionId: string) => ({ interactionId, sessionId: payload.childSessionId });
  const subject = { callId: payload.callId };
  const opening: string[] = [];
  if (payload.kind === "subagent-input-request") {
    for (const request of payload.event.requests) {
      if (tables.interactions[request.requestId] !== undefined) continue;
      opening.push(request.requestId);
      events.push(
        interactionOpened(request, { origin: origin(request.requestId), scope, subject }),
      );
    }
  } else {
    const { event } = payload;
    const mirror = tables.interactions[event.data.interactionId];
    if (event.type === "interaction.opened") {
      if (mirror === undefined) {
        opening.push(event.data.interactionId);
        const data: { -readonly [K in keyof typeof event.data]: (typeof event.data)[K] } = {
          ...event.data,
          subject,
        };
        data.origin = origin(event.data.interactionId);
        events.push({ data, scope, type: "interaction.opened" });
      }
    } else if (event.type === "interaction.settled") {
      if (mirror?.status === "open") events.push(...mirrorSettled(tables, event.data, scope));
    } else if (mirror !== undefined) {
      // How the asker settled an answer this session forwarded; a deciding one settles with
      // its interaction.
      const answer = forwardedAnswer(tables, event.data);
      if (answer !== undefined && event.data.outcome !== "applied")
        events.push(responseSettled(answer, event.data.outcome, event.data.reason));
    }
  }
  // A task's request waits on its task, not on the turn.
  if (opening.length > 0 && taskId === undefined)
    events.push(...hold(view, { on: "input", opening }).events);
  if (payload.kind !== "subagent-input-request") return unchanged(view, events);
  // A child's fresh batch replaces the routes its prior one held.
  const entries = toProxyInputRequestEntries(payload).map(
    ([requestId, route]) =>
      [
        requestId,
        {
          ...route,
          ...(input.workflowAsk !== undefined && { workflowAsk: input.workflowAsk }),
          ...(input.runId !== undefined && { runId: input.runId }),
        },
      ] as const,
  );
  return {
    ...unchanged(view, events),
    relays: {
      upsert: {
        entries,
        forChildContinuationToken: payload.childContinuationToken,
        inputSource: payload.inputSource,
      },
    },
  };
}

/** The asker settled what this session mirrors: the mirror settles the same way. */
function mirrorSettled(
  tables: ReturnType<typeof publicViewOf>,
  settled: FactOf<"interaction.settled">["data"],
  scope: { readonly turnId?: string; readonly taskId?: string },
): SessionEvent[] {
  const open = Object.values(tables.responses)
    .filter((row) => row.interactionId === settled.interactionId && row.status !== "settled")
    .sort((a, b) => a.introducedAt - b.introducedAt);
  const decided =
    settled.outcome === "accepted" ||
    settled.outcome === "declined" ||
    settled.outcome === "invalid";
  const decider = decided ? open.at(-1) : undefined;
  const events: SessionEvent[] = open.map((row) =>
    responseSettled(row.responseId, row === decider ? "applied" : "withdrawn", settled.reason),
  );
  events.push(
    interactionSettled(settled.interactionId, settled.outcome, {
      cause: decider === undefined ? undefined : { responseId: decider.responseId },
      reason: settled.reason,
      response: answerOf(settled.interactionId, settled.response),
      scope,
    }),
  );
  return events;
}

function answerOf(
  requestId: string,
  detail: { readonly [key: string]: unknown } | undefined,
): InputResponse | undefined {
  if (detail === undefined) return undefined;
  const answer: { requestId: string; optionId?: string; text?: string } = { requestId };
  if (typeof detail.optionId === "string") answer.optionId = detail.optionId;
  if (typeof detail.text === "string") answer.text = detail.text;
  return answer.optionId === undefined && answer.text === undefined ? undefined : answer;
}

/** The answer this session forwarded that an asker's settlement is about. */
function forwardedAnswer(
  tables: ReturnType<typeof publicViewOf>,
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

/** The outcome an interaction settles with when this session decides a relayed request. */
function decidedOutcome(outcome: InputResolution["outcome"]) {
  switch (outcome) {
    case "approved":
    case "answered":
      return "accepted" as const;
    case "denied":
      return "declined" as const;
    case "invalid":
      return "invalid" as const;
    default:
      return "withdrawn" as const;
  }
}

/**
 * Answers to requests this session relays went on to their askers. Each delivery that carried
 * such answers is admitted here, with the answers it forwarded: a message that answered joins
 * the turn that asked, one that also carries input for this session goes on to its turn, and
 * any other took effect once forwarded. A question this session decides settles now; an
 * approval stays open until its asker settles it.
 */
export function routeAnswer(
  view: SessionView,
  input: {
    readonly deliveries: readonly {
      readonly deliveryId: string;
      readonly principal?: Principal;
      readonly source?: DeliverySource;
      /** A message that answered: the turn that asked consumes it. */
      readonly consumed?: { readonly turnId: string; readonly parts: readonly UserPart[] };
      /** The delivery also carries input for this session, whose turn consumes and settles it. */
      readonly continues?: true;
    }[];
    /** Every answer forwarded, as admitted. */
    readonly forwarded: readonly ResponseSubmittedData[];
    /** The requests this session settles now. */
    readonly decided: readonly InputResolution[];
    /**
     * Answers left other relayed requests pending, and nothing for the turn itself: the open
     * turn stays held, as after a partial approval answer.
     */
    readonly holds?: boolean;
  },
): Transition {
  const tables = publicViewOf(view.projection);
  const events: SessionEvent[] = [];
  const admitted = new Set<string>();
  for (const delivery of input.deliveries) {
    if (tables.deliveries[delivery.deliveryId] !== undefined || admitted.has(delivery.deliveryId))
      continue;
    admitted.add(delivery.deliveryId);
    const data: { deliveryId: string; principal?: Principal; source?: DeliverySource } = {
      deliveryId: delivery.deliveryId,
    };
    if (delivery.principal !== undefined) data.principal = delivery.principal;
    if (delivery.source !== undefined) data.source = delivery.source;
    events.push({ data, type: "delivery.admitted" });
    if (delivery.consumed !== undefined) {
      const { parts, turnId } = delivery.consumed;
      events.push({
        data: { deliveryId: delivery.deliveryId, parts, turnId },
        scope: { turnId },
        type: "delivery.consumed",
      });
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
  for (const resolution of input.decided) {
    const row = tables.interactions[resolution.requestId];
    if (row?.status !== "open") continue;
    const answers = [
      ...Object.values(tables.responses)
        .filter((entry) => entry.interactionId === row.interactionId && entry.status !== "settled")
        .map((entry) => entry.responseId),
      ...[...submitted.values()]
        .filter((binding) => binding.interactionId === row.interactionId)
        .map((binding) => binding.responseId),
    ];
    const decider = resolution.response === undefined ? undefined : answers.at(-1);
    for (const responseId of answers)
      events.push(responseSettled(responseId, responseId === decider ? "applied" : "withdrawn"));
    const owner = interactionOwner(tables, row);
    const scope: { turnId?: string; taskId?: string } = {};
    if (owner.turnId !== undefined) scope.turnId = owner.turnId;
    if (owner.taskId !== undefined) scope.taskId = owner.taskId;
    events.push(
      interactionSettled(row.interactionId, decidedOutcome(resolution.outcome), {
        cause: decider === undefined ? undefined : { responseId: decider },
        response: resolution.response,
        scope,
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
    events.push({
      data: { deliveryId: delivery.deliveryId, outcome: "applied" },
      type: "delivery.settled",
    });
  }
  if (input.holds === true) events.push(...hold(view, { on: "input" }).events);
  // The answered routes retire, so a later delivery can't route through them.
  const retire = input.decided.map((resolution) => resolution.requestId);
  return { ...unchanged(view, events), ...(retire.length > 0 && { relays: { retire } }) };
}

/**
 * A workflow run's sign-in, reported to the session that owns the run, which mirrors it: opened
 * while the run waits, then how it settled.
 */
export function runSignIn(
  from: { readonly taskId?: string; readonly turnId: string },
  challenge: AuthorizationChallenge,
  outcome?: "authorized" | "failed",
): SubagentAuthorizationEventHookPayload["event"] {
  if (outcome === undefined) {
    const scope: { turnId: string; taskId?: string } = { turnId: from.turnId };
    if (from.taskId !== undefined) scope.taskId = from.taskId;
    return {
      data: signInOpened(challenge, {
        prompt: `Sign in to ${challenge.name} to continue.`,
        scope,
        subject: from.taskId === undefined ? { turnId: from.turnId } : { taskId: from.taskId },
      }).data,
      type: "interaction.opened",
    };
  }
  return {
    data: {
      interactionId: signInInteractionId(challenge),
      outcome: outcome === "authorized" ? "accepted" : "failed",
    },
    type: "interaction.settled",
  };
}

// ---------------------------------------------------------------------------
// Sign-ins
// ---------------------------------------------------------------------------

/**
 * Sign-in callbacks matched the attempts `attemptIds` name: the session stops waiting on them.
 * Their completions report once the turn they resume runs (`completeSignIn`).
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

/**
 * Sign-in callbacks arrived: each attempt the session still waits on is accepted. A callback is a
 * delivery whose response carries no value: the provider's payload stays private, and the
 * public record says only that the attempt completed.
 */
export function completeSignIn(
  view: SessionView,
  input: { readonly completions: readonly AuthorizationChallenge[] },
): Transition {
  const tables = publicViewOf(view.projection);
  return unchanged(
    view,
    input.completions.flatMap((challenge): SessionEvent[] => {
      const interactionId = signInInteractionId(challenge);
      const row = tables.interactions[interactionId];
      if (row?.status !== "open") return [];
      // One callback per attempt reaches the session, so the attempt names its delivery.
      const deliveryId = `callback_${interactionId}`;
      const responseId = `response_${deliveryId}`;
      const owner = interactionOwner(tables, row);
      const scope: { turnId?: string; taskId?: string } = {};
      if (owner.turnId !== undefined) scope.turnId = owner.turnId;
      if (owner.taskId !== undefined) scope.taskId = owner.taskId;
      return [
        { data: { deliveryId, source: { callback: "authorization" } }, type: "delivery.admitted" },
        responseSubmitted({ deliveryId, interactionId, responseId }),
        responseSettled(responseId, "applied"),
        interactionSettled(interactionId, "accepted", { cause: { responseId }, scope }),
        deliveryApplied(deliveryId),
      ];
    }),
  );
}

// ---------------------------------------------------------------------------
// Cancel and clear
// ---------------------------------------------------------------------------

/** Requests this session asked itself and still awaits; relayed requests answer elsewhere. */
export function ownOpenRequestIds(view: Omit<SessionView, "turn">): ReadonlySet<string> {
  return new Set(
    openRequests(view.projection.view)
      .filter(
        (input) =>
          input.callId === undefined &&
          input.taskId === undefined &&
          !view.relayedRequestIds.has(input.request.requestId),
      )
      .map((input) => input.request.requestId),
  );
}

/**
 * The delivery a clear or compact arrived as. One that names none, from a caller that predates
 * control ids, is named by the position it applies at.
 */
export function controlDeliveryFor(view: SessionView, given?: ControlDelivery): ControlDelivery {
  return given ?? { deliveryId: `control_${String(view.projection.position ?? 0)}` };
}

/** A control's admission: the delivery it arrived as, its kind, and who sent it. */
export function controlAdmitted(delivery: ControlDelivery, control: string): SessionEvent {
  const data: { -readonly [K in keyof DeliveryAdmittedData]: DeliveryAdmittedData[K] } = {
    deliveryId: delivery.deliveryId,
    source: { control },
  };
  if (delivery.principal !== undefined) data.principal = delivery.principal;
  return { data, type: "delivery.admitted" };
}

/** A control or callback delivery's settlement once what it asked has happened. */
export function deliveryApplied(deliveryId: string): SessionEvent {
  return { data: { deliveryId, outcome: "applied" }, type: "delivery.settled" };
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
  const tables = publicViewOf(projection);
  const closingTurn = activeTurn(tables)?.turnId ?? turnId;
  const turn =
    closingTurn === undefined
      ? undefined
      : turnClosure(projection, closingTurn, { cause: input.cause, outcome: "cancelled" });
  const closed = new Set(turn?.closed.interactions.map((row) => row.interactionId));
  // The cancel also stops the work behind every relayed request and the stopped steps' asks.
  const events: SessionEvent[] = Object.values(tables.interactions)
    .filter(
      (row) =>
        row.status === "open" &&
        !closed.has(row.interactionId) &&
        (view.relayedRequestIds.has(row.interactionId) ||
          stoppedRequestIds.has(row.interactionId) ||
          row.request.kind === "budget"),
    )
    .flatMap((row) => withdrawInteraction(tables, row.interactionId, "Cancelled.", "interrupted"));
  events.push(...(turn?.facts ?? []));
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
      ...clearedInteractions(view),
      // Clear runs between turns. A paused turn still owns a lifecycle; end it and its
      // non-task work before selecting an empty conversation, instead of dropping only its
      // private suspended steps and leaving the public turn and calls open forever.
      ...closeTurn(projection, { cause: input.cause, outcome: "cancelled" }),
      contextStarted({ cause: input.cause, changeId, kind: "clear" }),
      {
        data: { changeId, kind: "clear", outcome: "completed", selects: null },
        type: "context.settled",
      },
    ],
    turn: { grants: view.turn.grants, suspended: [] } satisfies TurnState,
  };
}

/**
 * What a clear withdraws beyond the turn it closes: the requests the cleared history asked for
 * outside it. Requests relayed from live tasks stay.
 */
function clearedInteractions(view: SessionView): SessionEvent[] {
  const tables = publicViewOf(view.projection);
  const turnId = activeTurn(tables)?.turnId ?? view.projection.activeTurnId;
  const closed = new Set(
    turnId === undefined
      ? []
      : openWork(tables, { turnId }).interactions.map((row) => row.interactionId),
  );
  return Object.values(tables.interactions)
    .filter(
      (row) =>
        row.status === "open" &&
        !closed.has(row.interactionId) &&
        !view.relayedRequestIds.has(row.interactionId),
    )
    .flatMap((row) =>
      withdrawInteraction(tables, row.interactionId, "The context was cleared.", "interrupted"),
    );
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
